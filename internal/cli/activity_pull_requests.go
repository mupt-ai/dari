package cli

import (
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
)

func newActivityPullRequestsCmd(gf *globalFlags) *cobra.Command {
	cmd := &cobra.Command{Use: "pull-requests", Short: "Read pull requests and the agent sessions that worked on them"}
	var organizationID, search string
	var limit, offset int
	list := &cobra.Command{
		Use:   "list",
		Short: "List pull requests with attached traces, newest first",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if limit < 1 || offset < 0 {
				return fmt.Errorf("--limit must be positive and --offset cannot be negative")
			}
			query := url.Values{"limit": {strconv.Itoa(limit)}, "offset": {strconv.Itoa(offset)}}
			setOptionalQuery(query, "search", search)
			return requestActivity(cmd, gf, organizationID, "pull-requests", query)
		},
	}
	list.Flags().StringVar(&organizationID, "organization-id", "", "Read an explicit organization using browser login")
	list.Flags().StringVar(&search, "search", "", "Search repository, number, and title")
	list.Flags().IntVar(&limit, "limit", 20, "Maximum pull requests to return")
	list.Flags().IntVar(&offset, "offset", 0, "Number of pull requests to skip")

	var showOrganizationID string
	show := &cobra.Command{
		Use:   "show <owner/repo#number | pull request URL>",
		Short: "Show a pull request's attached traces",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			pr, err := parsePullRequestRef(args[0])
			if err != nil {
				return err
			}
			return requestActivity(cmd, gf, showOrganizationID, "pull-requests/"+pr.path(), nil)
		},
	}
	show.Flags().StringVar(&showOrganizationID, "organization-id", "", "Read an explicit organization using browser login")
	cmd.AddCommand(list, show)
	return cmd
}

type pullRequestRef struct {
	owner, repo string
	number      int
}

func (pr pullRequestRef) path() string {
	return url.PathEscape(pr.owner) + "/" + url.PathEscape(pr.repo) + "/" + strconv.Itoa(pr.number)
}

var pullRequestRefPattern = regexp.MustCompile(`^(?:https://github\.com/)?([\w.-]+)/([\w.-]+)(?:#|/pull/)(\d+)/?$`)

func parsePullRequestRef(value string) (pullRequestRef, error) {
	match := pullRequestRefPattern.FindStringSubmatch(strings.TrimSpace(value))
	if match == nil {
		return pullRequestRef{}, fmt.Errorf("expected owner/repo#number or a GitHub pull request URL, got %q", value)
	}
	number, err := strconv.Atoi(match[3])
	if err != nil {
		return pullRequestRef{}, fmt.Errorf("invalid pull request number %q", match[3])
	}
	return pullRequestRef{owner: match[1], repo: match[2], number: number}, nil
}
