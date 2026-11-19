package cli

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/mupt-ai/dari/internal/api"
)

// `dari router` acts on wherever coding agents route: the hosted org, or a
// local or self-hosted gateway, which runs router spec files. --hosted acts
// on the hosted org from a gateway.

// routerGateway is the gateway `dari router` acts on, or nil for hosted.
func routerGateway(cmd *cobra.Command) (*gatewayConfig, error) {
	if hosted, _ := cmd.Flags().GetBool("hosted"); hosted {
		return nil, nil
	}
	gw, err := currentGateway()
	if err != nil || gw == nil {
		return nil, err
	}
	if err := gw.ensure(cmd.Context(), cmd.ErrOrStderr()); err != nil {
		return nil, err
	}
	return gw, nil
}

func gatewayRouterClient(gw *gatewayConfig) *api.Client {
	return api.New(gw.url).WithBearer(gw.key)
}

// gatewayRouterError is what the gateway refused, in its own words; an older
// gateway without router specs says to update it.
func gatewayRouterError(err error) error {
	he := api.AsHTTPError(err)
	if he == nil {
		return err
	}
	var refused struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal([]byte(he.Detail), &refused)
	switch {
	case refused.Error.Code == "not_found":
		return errors.New("this gateway does not run router spec files yet; update Dari Gateway")
	case refused.Error.Message != "":
		return errors.New(refused.Error.Message)
	}
	return api.HumanError(err)
}

func gatewayRouterPath(id string) string {
	return "/v1/routers/" + url.PathEscape(id)
}

func listGatewayRouters(cmd *cobra.Command, gw *gatewayConfig) error {
	var resp map[string]any
	if err := gatewayRouterClient(gw).Do(cmd.Context(), http.MethodGet, "/v1/routers", nil, &resp); err != nil {
		return gatewayRouterError(err)
	}
	return printJSON(resp)
}

func getGatewayRouter(cmd *cobra.Command, gw *gatewayConfig, id string) error {
	var spec []byte
	if err := gatewayRouterClient(gw).Do(cmd.Context(), http.MethodGet, gatewayRouterPath(id), nil, &spec); err != nil {
		return gatewayRouterError(err)
	}
	_, err := cmd.OutOrStdout().Write(spec)
	return err
}

// putGatewayRouter saves a spec on the gateway under id and prints what it
// saved.
func putGatewayRouter(cmd *cobra.Command, gw *gatewayConfig, id, spec string) error {
	var saved map[string]any
	if err := gatewayRouterClient(gw).Do(cmd.Context(), http.MethodPut, gatewayRouterPath(id), map[string]any{"spec_yaml": spec}, &saved); err != nil {
		return gatewayRouterError(err)
	}
	fmt.Fprintf(cmd.ErrOrStderr(), "Saved on the gateway; agents reach it at %s/%s\n", gw.url, id)
	return printJSON(saved)
}

func deleteGatewayRouter(cmd *cobra.Command, gw *gatewayConfig, id string) error {
	if err := gatewayRouterClient(gw).Do(cmd.Context(), http.MethodDelete, gatewayRouterPath(id), nil, nil); err != nil {
		return gatewayRouterError(err)
	}
	fmt.Fprintf(cmd.ErrOrStderr(), "Removed %s from the gateway\n", id)
	return nil
}

// gatewayRouterIDForFile is a spec file's router ID on a gateway: its name
// without the extension, or its directory's for a router.yaml.
func gatewayRouterIDForFile(path string) string {
	stem := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	if stem == "router" || stem == "." || stem == "" {
		abs, _ := filepath.Abs(path)
		if filepath.Ext(path) == "" {
			stem = filepath.Base(abs)
		} else {
			stem = filepath.Base(filepath.Dir(abs))
		}
	}
	return strings.Trim(gatewayRouterIDPattern.ReplaceAllString(strings.ToLower(stem), "-"), "-")
}

func newRouterPullCmd(gf *globalFlags) *cobra.Command {
	var as string
	cmd := &cobra.Command{
		Use:   "pull <template|router_id>",
		Short: "Copy a template, or one of your hosted routers, onto the gateway (or a template into your org)",
		Long: "Copy a router to where your agents route. On a local or self-hosted gateway it fetches the\n" +
			"template's or hosted router's spec from hosted Dari and saves it on the gateway, under its\n" +
			"name or --as. Hosted, it copies a template into your org, as `dari setup <agent> --router\n" +
			"<template>` does.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			choice := agentRouterChoice{name: strings.TrimSpace(args[0])}
			if choice.file() {
				return errors.New("pull takes a template or router ID; for a file use `dari router apply`")
			}
			gw, err := routerGateway(cmd)
			if err != nil {
				return err
			}
			if gw == nil {
				if choice.routerID() {
					return errors.New("that router is already in your org")
				}
				var resp map[string]any
				path := "/v1/organizations/current/experimental-routers/" + url.PathEscape(choice.name) + "/apply"
				if err := orgKeyRequest(cmd, gf, http.MethodPost, path, nil, &resp); err != nil {
					return err
				}
				return printJSON(resp)
			}
			spec, id, err := gatewayRouterSpec(cmd.Context(), choice)
			if err != nil {
				return err
			}
			return putGatewayRouter(cmd, gw, cmp.Or(as, id), spec)
		},
	}
	cmd.Flags().StringVar(&as, "as", "", "Router ID on the gateway (default: the template's name or router ID)")
	return cmd
}
