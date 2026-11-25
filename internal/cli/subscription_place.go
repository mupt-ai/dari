package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"

	"github.com/mupt-ai/dari/internal/api"
	"github.com/mupt-ai/dari/internal/auth"
	"github.com/mupt-ai/dari/internal/gateway"
)

// subscriptionPlace is where a plan's token lives: on hosted Dari, on this
// computer's gateway synced to Dari, or on this computer's gateway privately.
type subscriptionPlace string

const (
	placeDari     subscriptionPlace = "dari"
	placeComputer subscriptionPlace = "computer"
	placePrivate  subscriptionPlace = "private"
)

// localSubscription is a plan a user's own gateway reports to hosted Dari.
type localSubscription struct {
	ID          string `json:"id"`
	GatewayID   string `json:"gateway_id"`
	GatewayName string `json:"gateway_name"`
	LocalID     string `json:"local_id"`
	Provider    string `json:"provider"`
}

var placeOptions = map[subscriptionPlace]agentChoiceOption{
	placeComputer: {label: "On This Computer", description: "Token stays here; usage and Activity sync to Dari"},
	placeDari:     {label: "On Dari", description: "Works everywhere, including Link apps and cloud agents"},
	placePrivate:  {label: "Private", description: "Nothing leaves this computer"},
}

func parseSubscriptionPlace(value string) (subscriptionPlace, error) {
	switch place := subscriptionPlace(strings.ToLower(strings.TrimSpace(value))); place {
	case placeDari, placeComputer, placePrivate:
		return place, nil
	}
	return "", fmt.Errorf("--on must be dari, computer, or private, got %q", value)
}

// defaultSubscriptionPlace keeps Claude Code and Muse Code plans on this
// computer and every other plan on Dari.
func defaultSubscriptionPlace(provider agentSubscriptionProvider) subscriptionPlace {
	if provider.id == claudeSubscription.id || provider.id == museSubscription.id {
		return placeComputer
	}
	return placeDari
}

// subscriptionPlaces are the places in the order offered: the provider's
// default first.
func subscriptionPlaces(provider agentSubscriptionProvider) []subscriptionPlace {
	first := defaultSubscriptionPlace(provider)
	places := []subscriptionPlace{first}
	for _, place := range []subscriptionPlace{placeComputer, placeDari, placePrivate} {
		if place != first {
			places = append(places, place)
		}
	}
	return places
}

// chooseSubscriptionPlace is --on when given, else the picker in a terminal,
// else the provider's default. current, when set, is tagged in place of the
// default.
func chooseSubscriptionPlace(stdin io.Reader, stderr io.Writer, provider agentSubscriptionProvider, flag string, current subscriptionPlace) (subscriptionPlace, error) {
	if flag != "" {
		return parseSubscriptionPlace(flag)
	}
	places := subscriptionPlaces(provider)
	if !agentInputIsTerminal(stdin) {
		return places[0], nil
	}
	agentSubtitle = "Where your plans live"
	options := make([]agentChoiceOption, len(places))
	for index, place := range places {
		options[index] = placeOptions[place]
		switch {
		case current == place:
			options[index].label += " (Current)"
		case current == "" && index == 0:
			options[index].label += " (Default)"
		}
	}
	choice, err := runAgentChoiceTUI(stdin, stderr, "Where Should "+provider.name+" Live?", []string{"You can change this later."}, options)
	if err != nil {
		return "", err
	}
	return places[choice], nil
}

// selfHostedGateway reports whether subscriptions go to a gateway the user
// runs elsewhere, where they have no place to choose.
func selfHostedGateway() (bool, error) {
	gw, err := currentGateway()
	return gw != nil && !gw.local, err
}

// computerGateway starts this computer's gateway and returns it. In local
// mode it is the local gateway as it is; otherwise it is connected to hosted
// Dari when the user is signed in, which needHosted requires (signing in when
// it must).
func computerGateway(ctx context.Context, stdin io.Reader, stderr io.Writer, needHosted bool) (*gatewayConfig, error) {
	settings, ok, err := gateway.Load()
	if err != nil {
		return nil, err
	}
	if ok && settings.Mode == gateway.ModeLocal {
		gw := &gatewayConfig{url: gateway.LocalURL(), key: settings.LocalKey, local: true, settings: settings}
		return gw, gw.ensure(ctx, stderr)
	}
	if !ok {
		settings = gateway.Settings{Mode: gateway.ModeHosted}
	}
	if settings.LocalKey == "" {
		if settings.LocalKey, err = gateway.NewKey(); err != nil {
			return nil, err
		}
		if err := gateway.Save(settings); err != nil {
			return nil, err
		}
	}
	hostedKey := ""
	if needHosted || signedIn() {
		access, err := resolveAgentRoutingAccess(ctx, stdin, stderr)
		if err != nil {
			return nil, err
		}
		hostedKey = access.key
	}
	return connectedGateway(ctx, settings, hostedKey, stderr)
}

// connectedGateway starts this computer's gateway connected to hosted Dari
// with the user's routing key ("" starts it unconnected).
func connectedGateway(ctx context.Context, settings gateway.Settings, hostedKey string, stderr io.Writer) (*gatewayConfig, error) {
	if hostedKey != "" {
		settings.Hosted = &gateway.Hosted{URL: routingBaseURL, Key: hostedKey}
	}
	gw := &gatewayConfig{url: gateway.LocalURL(), key: settings.LocalKey, local: true, settings: settings}
	return gw, gw.ensure(ctx, stderr)
}

// computerPlanGateway is this computer's gateway, connected and running,
// when the user has a plan the agent uses on it; nil routes the launch
// through hosted Dari as before. A gateway that does not start only warns.
func computerPlanGateway(ctx context.Context, client *api.Client, agent, hostedKey string, stderr io.Writer) *gatewayConfig {
	settings, ok, err := gateway.Load()
	if err != nil || !ok || settings.GatewayID == "" || settings.LocalKey == "" {
		return nil
	}
	var listed agentSubscriptionStatus
	if err := client.Do(ctx, http.MethodGet, "/v1/organizations/current/credentials", nil, &listed); err != nil {
		return nil
	}
	usedBy := func(provider string) bool {
		return slices.ContainsFunc(agentSubscriptionProviders(agent), func(p agentSubscriptionProvider) bool { return p.id == provider })
	}
	synced := slices.ContainsFunc(listed.LocalSubscriptions, func(local localSubscription) bool {
		return local.GatewayID == settings.GatewayID && usedBy(local.Provider)
	})
	// A plan just connected here may not have reached hosted yet; a running
	// gateway answers for itself.
	if !synced && !(gateway.Healthy(ctx) && localPlanFor(ctx, settings, usedBy)) {
		return nil
	}
	gw, err := connectedGateway(ctx, settings, hostedKey, stderr)
	if err != nil {
		agentStep(stderr, fmt.Sprintf("Could not start the gateway for your plan on this computer (%v); routing through Dari", err))
		return nil
	}
	return gw
}

// localPlanFor reports whether the running local gateway has a plan, not
// private, of a provider the agent uses.
func localPlanFor(ctx context.Context, settings gateway.Settings, usedBy func(string) bool) bool {
	gw := &gatewayConfig{url: gateway.LocalURL(), key: settings.LocalKey, local: true, settings: settings}
	plans, err := localPlacedSubscriptions(ctx, gw)
	return err == nil && slices.ContainsFunc(plans, func(p placedSubscription) bool {
		return p.place == placeComputer && usedBy(p.OAuthProvider)
	})
}

func hostedSubscriptionClient(gf *globalFlags) (*api.Client, error) {
	apiURL, err := gf.resolveAPIURL()
	if err != nil {
		return nil, err
	}
	return auth.OrgKeyClient(apiURL)
}

func gatewayClient(gw *gatewayConfig) *api.Client {
	return api.New(gw.url).WithBearer(gw.key)
}

func thisComputer() string {
	hostname, _ := os.Hostname()
	return hostname
}

// connectSubscriptionAt signs a plan in where it is to live.
func connectSubscriptionAt(ctx context.Context, gf *globalFlags, provider agentSubscriptionProvider, place subscriptionPlace, stdin io.Reader, stderr io.Writer) error {
	if place == placeDari {
		client, err := hostedSubscriptionClient(gf)
		if err != nil {
			return err
		}
		return connectAgentPersonalSubscription(ctx, provider, client, stdin, stderr, "")
	}
	return connectOnComputer(ctx, provider, place, stdin, stderr)
}

// connectOnComputer signs a plan in on this computer's gateway, synced to
// Dari or private.
func connectOnComputer(ctx context.Context, provider agentSubscriptionProvider, place subscriptionPlace, stdin io.Reader, stderr io.Writer) error {
	gw, err := computerGateway(ctx, stdin, stderr, place == placeComputer)
	if err != nil {
		return err
	}
	done := provider.name + " connected on this computer (" + thisComputer() + ")"
	if place == placePrivate {
		done = provider.name + " connected privately on this computer"
	}
	return connectSubscription(ctx, provider, gatewayClient(gw), stdin, stderr, "", place == placePrivate, done)
}

// computerSubscriptions are the plans on this computer's gateway, each with
// its place, and the API that manages them: read when hosted Dari's listing
// (raw) names a plan of this gateway or the gateway has stored anything, and
// none otherwise.
func computerSubscriptions(ctx context.Context, raw []byte, stderr io.Writer) ([]subscriptionCredential, *api.Client, error) {
	settings, ok, err := gateway.Load()
	if err != nil || !ok || settings.LocalKey == "" {
		return nil, nil, err
	}
	var hosted struct {
		LocalSubscriptions []localSubscription `json:"local_subscriptions"`
	}
	_ = json.Unmarshal(raw, &hosted)
	synced := slices.ContainsFunc(hosted.LocalSubscriptions, func(local localSubscription) bool {
		return local.GatewayID == settings.GatewayID
	})
	if !synced && !gateway.HasDatabase() && !gateway.Healthy(ctx) {
		return nil, nil, nil
	}
	placed, gw, err := readComputerPlans(ctx, stderr)
	if err != nil {
		// The page still shows and manages the hosted plans.
		agentStep(stderr, fmt.Sprintf("Could not read the plans on this computer (%v)", err))
		return nil, nil, nil
	}
	plans := make([]subscriptionCredential, len(placed))
	for i, p := range placed {
		plans[i] = p.subscriptionCredential
	}
	return plans, gatewayClient(gw), nil
}

// hasBankedResets reports whether the plan's provider banks limit resets.
func hasBankedResets(subscription subscriptionCredential) bool {
	provider := subscriptionProviderFor(subscription.OAuthProvider)
	return provider == codexSubscription || provider == claudeSubscription
}

// placedSubscription is one plan wherever it lives, as the subscription
// commands list and address it.
type placedSubscription struct {
	subscriptionCredential
	place subscriptionPlace
	// where names the place: Dari, This Computer, Private, or another
	// computer's gateway.
	where string
}

// listPlacedSubscriptions lists the user's plans in every place: hosted
// Dari's (with other computers' plans by name) and this computer's
// gateway's. In local mode only the local gateway's. With lenient, a
// gateway that cannot be read only warns, for a listing; a command that
// picks one plan must not mistake a missing local plan for none.
func listPlacedSubscriptions(ctx context.Context, gf *globalFlags, stderr io.Writer, lenient bool) ([]placedSubscription, error) {
	settings, ok, err := gateway.Load()
	if err != nil {
		return nil, err
	}
	if ok && settings.Mode == gateway.ModeLocal {
		gw := &gatewayConfig{url: gateway.LocalURL(), key: settings.LocalKey, local: true, settings: settings}
		if err := gw.ensure(ctx, stderr); err != nil {
			return nil, err
		}
		return localPlacedSubscriptions(ctx, gw)
	}
	client, err := hostedSubscriptionClient(gf)
	if err != nil {
		return nil, err
	}
	var hosted struct {
		Credentials        []subscriptionCredential `json:"credentials"`
		LocalSubscriptions []localSubscription      `json:"local_subscriptions"`
	}
	if err := client.Do(ctx, http.MethodGet, "/v1/organizations/current/credentials?refresh_usage=true", nil, &hosted); err != nil {
		return nil, api.HumanError(err)
	}
	placed := []placedSubscription{}
	for _, credential := range personalSubscriptions(hosted.Credentials) {
		placed = append(placed, placedSubscription{credential, placeDari, "Dari"})
	}
	onThisComputer := false
	for _, local := range hosted.LocalSubscriptions {
		if settings.GatewayID != "" && local.GatewayID == settings.GatewayID {
			onThisComputer = true
			continue
		}
		placed = append(placed, placedSubscription{
			subscriptionCredential{Name: local.LocalID, OAuthProvider: local.Provider, CredentialScope: "user"},
			"", local.GatewayName,
		})
	}
	// Private plans are never reported to hosted Dari, so a gateway that has
	// stored anything is asked too.
	if onThisComputer || (settings.LocalKey != "" && (gateway.HasDatabase() || gateway.Healthy(ctx))) {
		local, _, err := readComputerPlans(ctx, stderr)
		if err != nil && !lenient {
			return nil, err
		}
		if err != nil {
			agentStep(stderr, fmt.Sprintf("Could not read the plans on this computer (%v)", err))
		}
		placed = append(placed, local...)
	}
	return placed, nil
}

// readComputerPlans starts this computer's gateway and lists its plans.
func readComputerPlans(ctx context.Context, stderr io.Writer) ([]placedSubscription, *gatewayConfig, error) {
	gw, err := computerGateway(ctx, nil, stderr, false)
	if err != nil {
		return nil, nil, err
	}
	placed, err := localPlacedSubscriptions(ctx, gw)
	return placed, gw, err
}

func localPlacedSubscriptions(ctx context.Context, gw *gatewayConfig) ([]placedSubscription, error) {
	var listed struct {
		Credentials []subscriptionCredential `json:"credentials"`
	}
	if err := gatewayClient(gw).Do(ctx, http.MethodGet, "/v1/organizations/current/credentials?refresh_usage=true", nil, &listed); err != nil {
		return nil, api.HumanError(err)
	}
	placed := []placedSubscription{}
	for _, credential := range personalSubscriptions(listed.Credentials) {
		if credential.Private {
			credential.place = placePrivate
			placed = append(placed, placedSubscription{credential, placePrivate, "Private"})
		} else {
			credential.place = placeComputer
			placed = append(placed, placedSubscription{credential, placeComputer, "This Computer"})
		}
	}
	return placed, nil
}

// findPlacedSubscription finds the plan a name or provider alias means,
// among those in on's place when given (dari, or computer for both of this
// computer's places).
func findPlacedSubscription(all []placedSubscription, arg, on string) (placedSubscription, error) {
	if on != "" {
		place, err := parseSubscriptionPlace(on)
		if err != nil {
			return placedSubscription{}, err
		}
		all = slices.DeleteFunc(slices.Clone(all), func(s placedSubscription) bool {
			return s.place == "" || (place == placeDari) != (s.place == placeDari)
		})
	}
	provider, alias := subscriptionProviders[strings.ToLower(strings.TrimSpace(arg))]
	var matches []placedSubscription
	for _, s := range all {
		if s.place == "" {
			continue // Another computer's plan is managed there.
		}
		if (alias && s.OAuthProvider == provider.id) || (!alias && normalizeSubscriptionName(s.Name) == normalizeSubscriptionName(arg)) {
			matches = append(matches, s)
		}
	}
	switch {
	case len(matches) == 1:
		return matches[0], nil
	case len(matches) == 0:
		return placedSubscription{}, fmt.Errorf("no subscription %q is connected here", arg)
	}
	places := map[bool]bool{}
	names := []string{}
	for _, s := range matches {
		places[s.place == placeDari] = true
		names = append(names, s.Name)
	}
	if len(places) == 2 {
		return placedSubscription{}, fmt.Errorf("%q is connected both on Dari and on this computer; pass --on dari or --on computer", arg)
	}
	return placedSubscription{}, fmt.Errorf("%d subscriptions match %q; pass one of: %s", len(matches), arg, strings.Join(names, ", "))
}

func normalizeSubscriptionName(name string) string {
	return strings.ToUpper(strings.TrimSpace(name))
}

// placedClient is the API that manages a plan: hosted Dari's, or this
// computer's gateway's.
func placedClient(ctx context.Context, gf *globalFlags, s placedSubscription, stderr io.Writer) (*api.Client, error) {
	if s.place == placeDari {
		return hostedSubscriptionClient(gf)
	}
	gw, err := computerGateway(ctx, nil, stderr, false)
	if err != nil {
		return nil, err
	}
	return gatewayClient(gw), nil
}

func disconnectPlaced(ctx context.Context, client *api.Client, name string) error {
	return api.HumanError(client.Do(ctx, http.MethodDelete,
		"/v1/organizations/current/credentials/"+url.PathEscape(name)+"?scope=user", nil, nil))
}

// moveSubscription moves a plan to another place: signing in there, then
// disconnecting it where it was. Between this computer's two places only its
// flag changes.
func moveSubscription(ctx context.Context, gf *globalFlags, s placedSubscription, to subscriptionPlace, stdin io.Reader, stderr io.Writer) error {
	provider := subscriptionProviderFor(s.OAuthProvider)
	if to == s.place {
		agentStep(stderr, provider.name+" already lives there")
		return nil
	}
	if s.place != placeDari && to != placeDari {
		gw, err := computerGateway(ctx, stdin, stderr, to == placeComputer)
		if err != nil {
			return err
		}
		if err := gatewayClient(gw).Do(ctx, http.MethodPut,
			"/v1/organizations/current/credentials/"+url.PathEscape(s.Name)+"/private",
			map[string]bool{"private": to == placePrivate}, nil); err != nil {
			return api.HumanError(err)
		}
		if to == placePrivate {
			agentStep(stderr, provider.name+" is now private on this computer")
		} else {
			agentStep(stderr, provider.name+" now syncs to Dari from this computer ("+thisComputer()+")")
		}
		return nil
	}
	from, err := placedClient(ctx, gf, s, stderr)
	if err != nil {
		return err
	}
	if err := connectSubscriptionAt(ctx, gf, provider, to, stdin, stderr); err != nil {
		return err
	}
	return disconnectPlaced(ctx, from, s.Name)
}

var errNoPlaces = errors.New("with a local or self-hosted gateway every subscription lives on it; there is no place to choose")

// routesThroughGateway reports whether subscriptions go to a gateway (fully
// local or self-hosted) rather than having a place to choose.
func routesThroughGateway() (bool, error) {
	gw, err := currentGateway()
	return gw != nil, err
}
