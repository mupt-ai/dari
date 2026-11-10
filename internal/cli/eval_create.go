package cli

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/spf13/cobra"
)

const (
	evalNameMaxChars         = 120
	evalDescriptionMaxChars  = 2_000
	evalScoreModelIDMaxChars = 200
	evalScoreNotesMaxChars   = 2_000
	evalScoreRowsMaxCount    = 5_000
)

type evalCreateFlags struct {
	name        string
	description string
	minScore    float64
	maxScore    float64
	file        string
}

type evalCreateRequest struct {
	Name        string             `json:"name"`
	Description *string            `json:"description"`
	MinScore    float64            `json:"min_score"`
	MaxScore    float64            `json:"max_score"`
	Scores      []evalScoreRequest `json:"scores"`
}

type evalScoreRequest struct {
	ModelID       string         `json:"model_id"`
	Score         float64        `json:"score"`
	Notes         *string        `json:"notes,omitempty"`
	ThinkingLevel *string        `json:"thinking_level,omitempty"`
	MetadataJSON  map[string]any `json:"metadata_json,omitempty"`
}

func newEvalCreateCmd(gf *globalFlags) *cobra.Command {
	flags := evalCreateFlags{}
	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create an eval scorecard from a CSV file",
		Long: `Create an eval scorecard for the current org from a CSV file.

The CSV header must start with model_id,score. Optional columns are
thinking_level, notes, and metadata_json. Pass --file - to read from stdin.`,
		Example: `  dari eval create --name "SWE-bench Verified" --file scores.csv
  cat scores.csv | dari eval create --name "SWE-bench Verified" --file -`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			body, err := flags.createRequest(cmd.InOrStdin())
			if err != nil {
				return err
			}
			var resp map[string]any
			if err := orgKeyRequest(
				cmd,
				gf,
				http.MethodPost,
				"/v1/organizations/current/evals",
				body,
				&resp,
			); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
	cmd.Flags().StringVar(&flags.name, "name", "", "Scorecard name")
	cmd.Flags().StringVar(&flags.description, "description", "", "Scorecard description")
	cmd.Flags().Float64Var(&flags.minScore, "min-score", 0, "Minimum possible score")
	cmd.Flags().Float64Var(&flags.maxScore, "max-score", 100, "Maximum possible score")
	cmd.Flags().StringVarP(&flags.file, "file", "f", "", "CSV file path, or - for stdin")
	_ = cmd.MarkFlagRequired("name")
	_ = cmd.MarkFlagRequired("file")
	return cmd
}

func (flags evalCreateFlags) createRequest(stdin io.Reader) (evalCreateRequest, error) {
	name := strings.TrimSpace(flags.name)
	if name == "" {
		return evalCreateRequest{}, errors.New("name must be non-empty")
	}
	if utf8.RuneCountInString(name) > evalNameMaxChars {
		return evalCreateRequest{}, fmt.Errorf("name must be at most %d characters", evalNameMaxChars)
	}

	description := strings.TrimSpace(flags.description)
	if utf8.RuneCountInString(description) > evalDescriptionMaxChars {
		return evalCreateRequest{}, fmt.Errorf("description must be at most %d characters", evalDescriptionMaxChars)
	}
	if !isFinite(flags.minScore) || !isFinite(flags.maxScore) {
		return evalCreateRequest{}, errors.New("min-score and max-score must be finite numbers")
	}
	if flags.minScore >= flags.maxScore {
		return evalCreateRequest{}, errors.New("min-score must be less than max-score")
	}

	scores, err := loadEvalScoresCSV(flags.file, stdin)
	if err != nil {
		return evalCreateRequest{}, err
	}
	for _, score := range scores {
		if score.Score < flags.minScore || score.Score > flags.maxScore {
			return evalCreateRequest{}, fmt.Errorf(
				"score %v for model_id %q must be between %v and %v",
				score.Score,
				score.ModelID,
				flags.minScore,
				flags.maxScore,
			)
		}
	}
	request := evalCreateRequest{
		Name:     name,
		MinScore: flags.minScore,
		MaxScore: flags.maxScore,
		Scores:   scores,
	}
	if description != "" {
		request.Description = &description
	}
	return request, nil
}

func loadEvalScoresCSV(rawPath string, stdin io.Reader) ([]evalScoreRequest, error) {
	path := strings.TrimSpace(rawPath)
	if path == "" {
		return nil, errors.New("eval CSV file path is required")
	}
	if path == "-" {
		scores, err := parseEvalScoresCSV(stdin)
		if err != nil {
			return nil, fmt.Errorf("parse eval CSV from stdin: %w", err)
		}
		return scores, nil
	}

	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open eval CSV %s: %w", path, err)
	}
	defer file.Close()

	scores, err := parseEvalScoresCSV(file)
	if err != nil {
		return nil, fmt.Errorf("parse eval CSV %s: %w", path, err)
	}
	return scores, nil
}

func parseEvalScoresCSV(source io.Reader) ([]evalScoreRequest, error) {
	reader := csv.NewReader(source)
	reader.FieldsPerRecord = -1

	header, err := reader.Read()
	if errors.Is(err, io.EOF) {
		return nil, errors.New("CSV must include model_id and score columns")
	}
	if err != nil {
		return nil, fmt.Errorf("read header: %w", err)
	}
	columns, err := evalCSVColumns(header)
	if err != nil {
		return nil, err
	}

	scores := []evalScoreRequest{}
	seen := map[string]int{}
	for rowNumber := 2; ; rowNumber++ {
		record, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("CSV row %d: %w", rowNumber, err)
		}
		if evalCSVRecordBlank(record) {
			continue
		}
		if len(record) != len(header) {
			return nil, fmt.Errorf("CSV row %d has %d columns; expected %d", rowNumber, len(record), len(header))
		}
		score, err := parseEvalCSVScore(record, columns, rowNumber)
		if err != nil {
			return nil, err
		}
		key := score.ModelID + "\x00"
		if score.ThinkingLevel != nil {
			key += *score.ThinkingLevel
		}
		if firstRow, exists := seen[key]; exists {
			suffix := ""
			if score.ThinkingLevel != nil {
				suffix = fmt.Sprintf(" at thinking_level %q", *score.ThinkingLevel)
			}
			return nil, fmt.Errorf(
				"CSV row %d duplicates model_id %q%s from row %d",
				rowNumber,
				score.ModelID,
				suffix,
				firstRow,
			)
		}
		seen[key] = rowNumber
		scores = append(scores, score)
		if len(scores) > evalScoreRowsMaxCount {
			return nil, fmt.Errorf("CSV can contain at most %d score rows", evalScoreRowsMaxCount)
		}
	}
	return scores, nil
}

type evalCSVColumnIndexes struct {
	thinkingLevel int
	notes         int
	metadataJSON  int
}

func evalCSVColumns(header []string) (evalCSVColumnIndexes, error) {
	columns := evalCSVColumnIndexes{thinkingLevel: -1, notes: -1, metadataJSON: -1}
	if len(header) > 0 {
		header[0] = strings.TrimPrefix(header[0], "\ufeff")
	}
	allowed := map[string]bool{
		"model_id":       true,
		"score":          true,
		"thinking_level": true,
		"notes":          true,
		"metadata_json":  true,
	}
	hasBaseHeaders := len(header) >= 2 && header[0] == "model_id" && header[1] == "score"
	valid := hasBaseHeaders && len(header) <= len(allowed)
	seen := map[string]bool{}
	for index, value := range header {
		if !allowed[value] || seen[value] {
			valid = false
		}
		seen[value] = true
		switch value {
		case "thinking_level":
			columns.thinkingLevel = index
		case "notes":
			columns.notes = index
		case "metadata_json":
			columns.metadataJSON = index
		}
	}
	if !valid {
		return evalCSVColumnIndexes{}, errors.New(
			"CSV header must be model_id,score with optional thinking_level, notes, and metadata_json columns",
		)
	}
	return columns, nil
}

func parseEvalCSVScore(record []string, columns evalCSVColumnIndexes, rowNumber int) (evalScoreRequest, error) {
	modelID := strings.TrimSpace(record[0])
	if modelID == "" {
		return evalScoreRequest{}, fmt.Errorf("CSV row %d is missing model_id", rowNumber)
	}
	if utf8.RuneCountInString(modelID) > evalScoreModelIDMaxChars {
		return evalScoreRequest{}, fmt.Errorf(
			"CSV row %d model_id must be at most %d characters",
			rowNumber,
			evalScoreModelIDMaxChars,
		)
	}

	rawScore := strings.TrimSpace(record[1])
	numericScore := strings.TrimSpace(strings.TrimSuffix(rawScore, "%"))
	score, err := strconv.ParseFloat(numericScore, 64)
	if numericScore == "" || err != nil || !isFinite(score) {
		return evalScoreRequest{}, fmt.Errorf("CSV row %d has invalid score %q for model_id %q", rowNumber, rawScore, modelID)
	}
	result := evalScoreRequest{ModelID: modelID, Score: score}

	if columns.thinkingLevel >= 0 {
		thinkingLevel := strings.ToLower(strings.TrimSpace(record[columns.thinkingLevel]))
		if thinkingLevel != "" {
			if !isEvalThinkingLevel(thinkingLevel) {
				return evalScoreRequest{}, fmt.Errorf(
					"CSV row %d has unsupported thinking_level %q (supported: off, minimal, low, medium, high, xhigh, max)",
					rowNumber,
					record[columns.thinkingLevel],
				)
			}
			result.ThinkingLevel = &thinkingLevel
		}
	}
	if columns.notes >= 0 {
		notes := strings.TrimSpace(record[columns.notes])
		if utf8.RuneCountInString(notes) > evalScoreNotesMaxChars {
			return evalScoreRequest{}, fmt.Errorf(
				"CSV row %d notes must be at most %d characters",
				rowNumber,
				evalScoreNotesMaxChars,
			)
		}
		if notes != "" {
			result.Notes = &notes
		}
	}
	if columns.metadataJSON >= 0 {
		rawMetadata := strings.TrimSpace(record[columns.metadataJSON])
		if rawMetadata != "" {
			var value any
			if err := json.Unmarshal([]byte(rawMetadata), &value); err != nil {
				return evalScoreRequest{}, fmt.Errorf("CSV row %d has invalid metadata_json: %w", rowNumber, err)
			}
			metadata, ok := value.(map[string]any)
			if !ok {
				return evalScoreRequest{}, fmt.Errorf("CSV row %d metadata_json must be a JSON object", rowNumber)
			}
			result.MetadataJSON = metadata
		}
	}
	return result, nil
}

func evalCSVRecordBlank(record []string) bool {
	for _, value := range record {
		if strings.TrimSpace(value) != "" {
			return false
		}
	}
	return true
}

func isEvalThinkingLevel(value string) bool {
	switch value {
	case "off", "minimal", "low", "medium", "high", "xhigh", "max":
		return true
	default:
		return false
	}
}

func isFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}
