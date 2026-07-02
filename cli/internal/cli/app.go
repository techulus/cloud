package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"

	"techulus/cloud-cli/internal/api"
	"techulus/cloud-cli/internal/auth"
	"techulus/cloud-cli/internal/manifest"
	"techulus/cloud-cli/internal/output"
)

const (
	cliClientID       = "techulus-cli"
	defaultLogTail    = 100
	logPollInterval   = 2 * time.Second
	defaultAPITimeout = 30 * time.Second
)

type App struct {
	Version       string
	Args          []string
	In            io.Reader
	Out           io.Writer
	Err           io.Writer
	HTTPClient    *http.Client
	Sleep         func(time.Duration)
	Now           func() time.Time
	IsInteractive func() bool
	GetCWD        func() (string, error)
	flags         globalFlags
}

type globalFlags struct {
	Agent bool
	JSON  bool
}

type handledError struct {
	err error
}

func (e handledError) Error() string {
	return e.err.Error()
}

func (e handledError) Unwrap() error {
	return e.err
}

func IsHandledError(err error) bool {
	var handled handledError
	return errors.As(err, &handled)
}

func Execute(version string, in io.Reader, out io.Writer, errOut io.Writer) error {
	app := NewApp(version, in, out, errOut)
	return app.Execute()
}

func NewApp(version string, in io.Reader, out io.Writer, errOut io.Writer) *App {
	return &App{
		Version:    version,
		In:         in,
		Out:        out,
		Err:        errOut,
		HTTPClient: &http.Client{Timeout: defaultAPITimeout},
		Sleep:      time.Sleep,
		Now:        time.Now,
		IsInteractive: func() bool {
			inFile, inOK := in.(*os.File)
			outFile, outOK := out.(*os.File)
			if !inOK || !outOK {
				return false
			}
			inStat, inErr := inFile.Stat()
			outStat, outErr := outFile.Stat()
			return inErr == nil && outErr == nil &&
				inStat.Mode()&os.ModeCharDevice != 0 &&
				outStat.Mode()&os.ModeCharDevice != 0
		},
		GetCWD: func() (string, error) {
			if cwd := os.Getenv("INIT_CWD"); cwd != "" {
				return cwd, nil
			}
			return os.Getwd()
		},
	}
}

func (a *App) Execute() error {
	cmd := a.rootCommand()
	cmd.SetIn(a.In)
	cmd.SetOut(a.Out)
	cmd.SetErr(a.Err)
	if a.Args != nil {
		cmd.SetArgs(a.Args)
	}
	if err := cmd.Execute(); err != nil {
		if a.isMachineOutput() {
			_ = a.writeError(err)
			return handledError{err: err}
		}
		return err
	}
	return nil
}

func (a *App) rootCommand() *cobra.Command {
	root := &cobra.Command{
		Use:           "tc",
		Short:         "Techulus Cloud CLI",
		SilenceUsage:  true,
		SilenceErrors: true,
		Annotations: map[string]string{
			"agent_notes": "Use --help --agent on any command for structured command metadata.\nUse --agent for raw JSON data on success; failures are returned as {\"ok\":false,\"error\":\"...\"}.\nUse --json for an ok/data envelope.",
		},
	}

	root.PersistentFlags().BoolVar(&a.flags.Agent, "agent", false, "Agent mode: raw JSON data on success and structured JSON errors")
	root.PersistentFlags().BoolVar(&a.flags.JSON, "json", false, "Output an ok/data JSON envelope")
	defaultHelp := root.HelpFunc()
	root.SetHelpFunc(func(cmd *cobra.Command, args []string) {
		if a.flags.Agent {
			_ = a.writeRaw(agentHelpForCommand(cmd))
			return
		}
		if a.flags.JSON {
			_ = a.writeData(agentHelpForCommand(cmd), "Help")
			return
		}
		defaultHelp(cmd, args)
	})

	root.AddCommand(a.authCommand())
	root.AddCommand(a.initCommand())
	root.AddCommand(a.linkCommand())
	root.AddCommand(a.applyCommand())
	root.AddCommand(a.deployCommand())
	root.AddCommand(a.statusCommand())
	root.AddCommand(a.logsCommand())
	root.AddCommand(a.versionCommand())
	root.AddCommand(a.completionCommand(root))

	return root
}

func (a *App) authCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "auth",
		Short: "Manage CLI authentication",
		Annotations: map[string]string{
			"agent_notes": "Most commands require an existing login. Use auth whoami to inspect the saved session.",
		},
	}
	cmd.AddCommand(a.authLoginCommand())
	cmd.AddCommand(a.authLogoutCommand())
	cmd.AddCommand(a.authWhoamiCommand())
	return cmd
}

func (a *App) authLoginCommand() *cobra.Command {
	var host string
	cmd := &cobra.Command{
		Use:   "login",
		Short: "Sign in with device login",
		Annotations: map[string]string{
			"agent_notes": "Device login requires browser approval and is not fully non-interactive.",
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			if a.isMachineOutput() {
				return errors.New("tc auth login requires human browser approval and does not support --agent or --json")
			}
			if host == "" {
				existing, err := auth.ReadConfig()
				if err != nil {
					return err
				}
				if existing != nil {
					host = existing.Host
				}
			}
			if host == "" {
				return errors.New("missing --host")
			}
			return a.runAuthLogin(cmd.Context(), api.NormalizeHost(host))
		},
	}
	cmd.Flags().StringVar(&host, "host", "", "Control plane host URL")
	return cmd
}

func (a *App) authLogoutCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Remove the saved CLI session",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := auth.DeleteConfig(); err != nil {
				return err
			}
			if a.isMachineOutput() {
				return a.writeData(map[string]string{"config": "removed"}, "Signed out")
			}
			output.Section(a.Out, "Signed out")
			output.Field(a.Out, "Config", "removed")
			return nil
		},
	}
}

func (a *App) authWhoamiCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "whoami",
		Short: "Show the current CLI account",
		RunE: func(cmd *cobra.Command, args []string) error {
			config, err := requireConfig()
			if err != nil {
				return err
			}
			var response struct {
				User auth.User `json:"user"`
			}
			client := a.client(config)
			if err := client.RequestJSON(cmd.Context(), http.MethodGet, "/api/v1/cli/auth/whoami", nil, nil, &response); err != nil {
				return err
			}
			result := authWhoamiOutput{
				User: response.User,
				Host: config.Host,
			}
			if a.isMachineOutput() {
				return a.writeData(result, "Account")
			}
			output.Section(a.Out, "Account")
			output.Field(a.Out, "User", result.User.Email)
			output.Field(a.Out, "Name", result.User.Name)
			output.Field(a.Out, "Host", result.Host)
			return nil
		},
	}
}

func (a *App) initCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "init",
		Short: "Create a starter techulus.yml",
		Annotations: map[string]string{
			"agent_notes": "Creates techulus.yml in the current working directory. Fails if techulus.yml already exists.",
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			cwd, err := a.GetCWD()
			if err != nil {
				return err
			}
			manifestPath := filepath.Join(cwd, "techulus.yml")
			if _, err := os.Stat(manifestPath); err == nil {
				return errors.New("techulus.yml already exists")
			} else if !errors.Is(err, os.ErrNotExist) {
				return err
			}

			folderName := manifest.Slugify(filepath.Base(cwd))
			if folderName == "" {
				folderName = "my-service"
			}
			starter := fmt.Sprintf(`apiVersion: v1
project: %s
environment: production
service:
  name: %s
  source:
    type: image
    image: nginx:1.27
  replicas:
    count: 1
  resources:
    cpuCores: 2
    memoryMb: 1024
  ports:
    - port: 80
      public: false
`, folderName, folderName)
			if err := os.WriteFile(manifestPath, []byte(starter), 0o644); err != nil {
				return err
			}
			if a.isMachineOutput() {
				return a.writeData(initOutput{Manifest: manifestPath, Next: "tc apply"}, "Manifest created")
			}
			output.Section(a.Out, "Manifest")
			output.Field(a.Out, "Created", manifestPath)
			output.Next(a.Out, "tc apply")
			return nil
		},
	}
}

func (a *App) linkCommand() *cobra.Command {
	var force bool
	cmd := &cobra.Command{
		Use:   "link",
		Short: "Create techulus.yml from an existing service",
		Annotations: map[string]string{
			"agent_notes": "Requires an interactive terminal and does not support --agent or --json. Agents should usually pass --project, --environment, and --service to status/logs instead of linking.",
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			if a.isMachineOutput() {
				return errors.New("tc link requires an interactive terminal and does not support --agent or --json")
			}
			if !a.IsInteractive() {
				return errors.New("tc link requires an interactive terminal")
			}
			config, err := requireConfig()
			if err != nil {
				return err
			}
			cwd, err := a.GetCWD()
			if err != nil {
				return err
			}
			manifestPath := filepath.Join(cwd, "techulus.yml")
			if _, err := os.Stat(manifestPath); err == nil && !force {
				return errors.New("techulus.yml already exists. Run `tc link --force` to replace it")
			} else if err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}

			client := a.client(config)
			var targets linkTargetsResponse
			if err := client.RequestJSON(cmd.Context(), http.MethodGet, "/api/v1/manifest/link-targets", nil, nil, &targets); err != nil {
				return err
			}
			if countSupportedServices(targets.Projects) == 0 {
				return errors.New("no linkable services were found in your account")
			}
			projectChoices := filterProjectsWithServices(targets.Projects)
			if len(projectChoices) == 0 {
				return errors.New("no services were found in your account")
			}
			reader := bufio.NewReader(a.In)
			project, err := selectFromList(reader, a.Out, "Select a project:", projectChoices, renderProjectChoice, nil)
			if err != nil {
				return err
			}
			environmentChoices := filterEnvironmentsWithServices(project.Environments)
			environment, err := selectFromList(reader, a.Out, "Select an environment:", environmentChoices, renderEnvironmentChoice, nil)
			if err != nil {
				return err
			}
			service, err := selectFromList(reader, a.Out, "Select a service:", environment.Services, renderServiceChoice, disabledServiceReason)
			if err != nil {
				return err
			}

			var result linkManifestResponse
			if err := client.RequestJSON(cmd.Context(), http.MethodPost, "/api/v1/manifest/link", nil, map[string]string{"serviceId": service.ID}, &result); err != nil {
				return err
			}
			if err := manifest.Save(manifestPath, result.Manifest); err != nil {
				return err
			}
			output.Section(a.Out, "Linked")
			output.Field(a.Out, "Service", fmt.Sprintf("%s/%s/%s", result.Service.Project, result.Service.Environment, result.Service.Name))
			output.Field(a.Out, "Manifest", manifestPath)
			output.Next(a.Out, "tc status  or  tc apply")
			return nil
		},
	}
	cmd.Flags().BoolVar(&force, "force", false, "Replace an existing techulus.yml")
	return cmd
}

func (a *App) applyCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "apply",
		Short: "Apply techulus.yml to the linked service",
		Annotations: map[string]string{
			"agent_notes": "Requires techulus.yml in the current directory and sends the full desired manifest to the control plane.",
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			config, err := requireConfig()
			if err != nil {
				return err
			}
			loaded, err := a.ensureManifest()
			if err != nil {
				return err
			}
			var result applyResponse
			client := a.client(config)
			if err := client.RequestJSON(cmd.Context(), http.MethodPost, "/api/v1/manifest/apply", nil, loaded.Manifest, &result); err != nil {
				return err
			}
			if a.isMachineOutput() {
				return a.writeData(result, "Apply")
			}
			printApplyResult(a.Out, result)
			return nil
		},
	}
}

func (a *App) deployCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "deploy",
		Short: "Deploy the service described by techulus.yml",
		Annotations: map[string]string{
			"agent_notes": "Requires techulus.yml in the current directory and queues a deployment for that service.",
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			config, err := requireConfig()
			if err != nil {
				return err
			}
			loaded, err := a.ensureManifest()
			if err != nil {
				return err
			}
			var result deployResponse
			client := a.client(config)
			if err := client.RequestJSON(cmd.Context(), http.MethodPost, "/api/v1/manifest/deploy", nil, loaded.Manifest, &result); err != nil {
				return err
			}
			if a.isMachineOutput() {
				return a.writeData(result, "Deploy")
			}
			output.Section(a.Out, "Deploy")
			output.Field(a.Out, "Service", output.ShortID(result.ServiceID))
			output.Field(a.Out, "Status", output.Status(result.Status))
			if result.RolloutID != nil && *result.RolloutID != "" {
				output.Field(a.Out, "Rollout", output.ShortID(*result.RolloutID))
			}
			output.Next(a.Out, "tc status")
			return nil
		},
	}
}

func (a *App) statusCommand() *cobra.Command {
	var target serviceTargetFlags
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show service rollout and deployment status",
		Annotations: map[string]string{
			"agent_notes": "Without explicit target flags, tc reads techulus.yml from the current directory.\nFor agent use outside a linked directory, pass --project, --environment, and --service together.",
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			config, err := requireConfig()
			if err != nil {
				return err
			}
			value, err := a.resolveServiceTarget(target)
			if err != nil {
				return err
			}
			var status statusResponse
			client := a.client(config)
			query := manifestIdentityQuery(value)
			if err := client.RequestJSON(cmd.Context(), http.MethodGet, "/api/v1/manifest/status", query, nil, &status); err != nil {
				return err
			}
			result := statusOutput{
				Target: serviceTargetFromManifest(value),
				Status: status,
			}
			if a.isMachineOutput() {
				return a.writeData(result, "Status")
			}
			printStatus(a.Out, value, status)
			return nil
		},
	}
	addServiceTargetFlags(cmd, &target)
	return cmd
}

func (a *App) logsCommand() *cobra.Command {
	var tail int
	var follow bool
	var target serviceTargetFlags
	cmd := &cobra.Command{
		Use:   "logs",
		Short: "Show service logs",
		Annotations: map[string]string{
			"agent_notes": "Without explicit target flags, tc reads techulus.yml from the current directory.\nFor agent use outside a linked directory, pass --project, --environment, and --service together.\nIn --agent or --json mode, logs are one-shot JSON output; --follow=true is not supported.",
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			if tail < 1 || tail > 1000 {
				return errors.New("log line count must be between 1 and 1000")
			}
			tailChanged := cmd.Flags().Changed("tail")
			if tailChanged && !cmd.Flags().Changed("follow") {
				follow = false
			}
			if a.isMachineOutput() {
				if cmd.Flags().Changed("follow") && follow {
					return errors.New("--follow=true is not supported with --agent or --json")
				}
				follow = false
			}
			config, err := requireConfig()
			if err != nil {
				return err
			}
			value, err := a.resolveServiceTarget(target)
			if err != nil {
				return err
			}
			return a.runLogs(cmd.Context(), config, value, tail, follow)
		},
	}
	cmd.Flags().IntVarP(&tail, "tail", "n", defaultLogTail, "Number of log lines to fetch")
	cmd.Flags().BoolVar(&follow, "follow", true, "Continue polling for new log lines")
	addServiceTargetFlags(cmd, &target)
	return cmd
}

func (a *App) versionCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print the tc version",
		RunE: func(cmd *cobra.Command, args []string) error {
			if a.isMachineOutput() {
				return a.writeData(map[string]string{"version": a.Version}, "Version")
			}
			fmt.Fprintln(a.Out, a.Version)
			return nil
		},
	}
}

func (a *App) completionCommand(root *cobra.Command) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "completion <bash|zsh|fish|powershell>",
		Short: "Generate shell completion scripts",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			switch args[0] {
			case "bash":
				return root.GenBashCompletion(a.Out)
			case "zsh":
				return root.GenZshCompletion(a.Out)
			case "fish":
				return root.GenFishCompletion(a.Out, true)
			case "powershell":
				return root.GenPowerShellCompletion(a.Out)
			default:
				return fmt.Errorf("unsupported shell %q", args[0])
			}
		},
	}
	return cmd
}

func (a *App) client(config *auth.Config) *api.Client {
	client := api.NewClient(config.Host, config.APIKey)
	client.HTTPClient = a.HTTPClient
	return client
}

func (a *App) ensureManifest() (*manifest.Loaded, error) {
	cwd, err := a.GetCWD()
	if err != nil {
		return nil, err
	}
	loaded, err := manifest.Load(cwd)
	if err == nil {
		return loaded, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("no techulus.yml found in the current directory. Run `tc init` to create one")
	}
	return nil, fmt.Errorf("invalid techulus.yml: %w", err)
}

func (a *App) isMachineOutput() bool {
	return a.flags.Agent || a.flags.JSON
}

func (a *App) writeData(data any, summary string) error {
	if a.flags.Agent {
		return a.writeRaw(data)
	}
	return output.OK(a.Out, data, summary)
}

func (a *App) writeRaw(data any) error {
	return output.JSON(a.Out, data)
}

func (a *App) writeError(err error) error {
	return output.Error(a.Out, err)
}

type agentHelpInfo struct {
	Command        string            `json:"command"`
	Path           string            `json:"path"`
	Short          string            `json:"short"`
	Long           string            `json:"long,omitempty"`
	Usage          string            `json:"usage"`
	Notes          []string          `json:"notes,omitempty"`
	Args           []agentArg        `json:"args,omitempty"`
	Subcommands    []agentSubcommand `json:"subcommands,omitempty"`
	Flags          []agentFlag       `json:"flags,omitempty"`
	InheritedFlags []agentFlag       `json:"inherited_flags,omitempty"`
}

type agentArg struct {
	Name     string   `json:"name"`
	Required bool     `json:"required"`
	Choices  []string `json:"choices,omitempty"`
}

type agentSubcommand struct {
	Name  string `json:"name"`
	Short string `json:"short"`
	Path  string `json:"path"`
}

type agentFlag struct {
	Name      string `json:"name"`
	Shorthand string `json:"shorthand,omitempty"`
	Type      string `json:"type"`
	Default   string `json:"default"`
	Usage     string `json:"usage"`
}

func agentHelpForCommand(cmd *cobra.Command) agentHelpInfo {
	info := agentHelpInfo{
		Command: cmd.Name(),
		Path:    cmd.CommandPath(),
		Short:   cmd.Short,
		Long:    cmd.Long,
		Usage:   cmd.UseLine(),
		Args:    parseAgentArgs(cmd),
	}
	if notes := strings.TrimSpace(cmd.Annotations["agent_notes"]); notes != "" {
		for _, note := range strings.Split(notes, "\n") {
			note = strings.TrimSpace(note)
			if note != "" {
				info.Notes = append(info.Notes, note)
			}
		}
	}
	for _, sub := range cmd.Commands() {
		if sub.IsAvailableCommand() || sub.Name() == "help" {
			info.Subcommands = append(info.Subcommands, agentSubcommand{
				Name:  sub.Name(),
				Short: sub.Short,
				Path:  sub.CommandPath(),
			})
		}
	}
	cmd.NonInheritedFlags().VisitAll(func(flag *pflag.Flag) {
		if flag.Name != "help" {
			info.Flags = append(info.Flags, agentFlagFor(flag))
		}
	})
	cmd.InheritedFlags().VisitAll(func(flag *pflag.Flag) {
		if flag.Name != "help" {
			info.InheritedFlags = append(info.InheritedFlags, agentFlagFor(flag))
		}
	})
	return info
}

func agentFlagFor(flag *pflag.Flag) agentFlag {
	return agentFlag{
		Name:      flag.Name,
		Shorthand: flag.Shorthand,
		Type:      flag.Value.Type(),
		Default:   flag.DefValue,
		Usage:     flag.Usage,
	}
}

func parseAgentArgs(cmd *cobra.Command) []agentArg {
	fields := strings.Fields(cmd.Use)
	if len(fields) <= 1 {
		return nil
	}
	args := make([]agentArg, 0, len(fields)-1)
	for _, field := range fields[1:] {
		required := strings.HasPrefix(field, "<") || (!strings.HasPrefix(field, "[") && !strings.HasSuffix(field, "]"))
		name := strings.Trim(field, "[]<>")
		if name == "" || name == "flags" {
			continue
		}
		arg := agentArg{Name: name, Required: required}
		if choices := parseAgentArgChoices(name); len(choices) > 0 {
			arg.Name = agentChoiceArgName(cmd)
			arg.Choices = choices
		}
		args = append(args, arg)
	}
	return args
}

func parseAgentArgChoices(name string) []string {
	if !strings.Contains(name, "|") {
		return nil
	}
	parts := strings.Split(name, "|")
	choices := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			return nil
		}
		choices = append(choices, part)
	}
	return choices
}

func agentChoiceArgName(cmd *cobra.Command) string {
	if cmd.Name() == "completion" {
		return "shell"
	}
	return "value"
}

type serviceTargetFlags struct {
	Project     string
	Environment string
	Service     string
}

func addServiceTargetFlags(cmd *cobra.Command, target *serviceTargetFlags) {
	cmd.Flags().StringVar(&target.Project, "project", "", "Project name or slug")
	cmd.Flags().StringVar(&target.Environment, "environment", "", "Environment name")
	cmd.Flags().StringVar(&target.Service, "service", "", "Service name")
}

func (a *App) resolveServiceTarget(target serviceTargetFlags) (manifest.Manifest, error) {
	project := strings.TrimSpace(target.Project)
	environment := strings.TrimSpace(target.Environment)
	service := strings.TrimSpace(target.Service)
	explicitCount := 0
	for _, value := range []string{project, environment, service} {
		if value != "" {
			explicitCount++
		}
	}
	if explicitCount == 0 {
		loaded, err := a.ensureManifest()
		if err != nil {
			return manifest.Manifest{}, err
		}
		return loaded.Manifest, nil
	}
	if explicitCount != 3 {
		return manifest.Manifest{}, errors.New("provide --project, --environment, and --service together")
	}
	return manifest.Manifest{
		APIVersion:  "v1",
		Project:     project,
		Environment: environment,
		Service: manifest.Service{
			Name: service,
		},
	}, nil
}

func serviceTargetFromManifest(value manifest.Manifest) serviceTargetOutput {
	return serviceTargetOutput{
		Project:     value.Project,
		Environment: value.Environment,
		Service:     value.Service.Name,
	}
}

func requireConfig() (*auth.Config, error) {
	config, err := auth.ReadConfig()
	if err != nil {
		return nil, err
	}
	if config == nil {
		return nil, errors.New("not logged in. Run `tc auth login --host <url>` first")
	}
	return config, nil
}

func (a *App) runAuthLogin(ctx context.Context, host string) error {
	var deviceCode deviceCodeResponse
	if err := api.JSON(ctx, a.HTTPClient, http.MethodPost, host+"/api/auth/device/code", nil, map[string]string{
		"client_id": cliClientID,
		"scope":     "cli",
	}, &deviceCode); err != nil {
		return err
	}

	verificationURL := deviceCode.VerificationURIComplete
	if verificationURL == "" {
		verificationURL = deviceCode.VerificationURI
	}
	output.Section(a.Out, "Device login")
	output.Field(a.Out, "Host", host)
	output.Field(a.Out, "URL", verificationURL)
	output.Field(a.Out, "Code", deviceCode.UserCode)
	fmt.Fprintln(a.Out, "\nOpen the verification URL in your browser to continue.")

	interval := time.Duration(deviceCode.Interval) * time.Second
	if interval <= 0 {
		interval = 5 * time.Second
	}
	expiresAt := a.Now().Add(time.Duration(deviceCode.ExpiresIn) * time.Second)
	var accessToken string
	for accessToken == "" {
		if deviceCode.ExpiresIn > 0 && !a.Now().Before(expiresAt) {
			return errors.New("device authorization expired")
		}
		a.Sleep(interval)
		if deviceCode.ExpiresIn > 0 && !a.Now().Before(expiresAt) {
			return errors.New("device authorization expired")
		}
		var tokenResponse deviceTokenResponse
		status, err := api.JSONStatus(ctx, a.HTTPClient, http.MethodPost, host+"/api/auth/device/token", map[string]string{
			"grant_type":  "urn:ietf:params:oauth:grant-type:device_code",
			"device_code": deviceCode.DeviceCode,
			"client_id":   cliClientID,
		}, &tokenResponse)
		if err != nil {
			return err
		}
		if status >= 200 && status < 300 && tokenResponse.AccessToken != "" {
			accessToken = tokenResponse.AccessToken
			break
		}
		switch tokenResponse.Error {
		case "authorization_pending":
			fmt.Fprint(a.Out, ".")
		case "slow_down":
			interval += 5 * time.Second
		case "access_denied":
			if tokenResponse.ErrorDescription != "" {
				return errors.New(tokenResponse.ErrorDescription)
			}
			return errors.New("device authorization was denied")
		case "expired_token":
			if tokenResponse.ErrorDescription != "" {
				return errors.New(tokenResponse.ErrorDescription)
			}
			return errors.New("device authorization expired")
		case "":
			return fmt.Errorf("unexpected response from device token endpoint: status %d", status)
		default:
			if tokenResponse.ErrorDescription != "" {
				return errors.New(tokenResponse.ErrorDescription)
			}
			return errors.New(tokenResponse.Error)
		}
	}

	fmt.Fprintln(a.Out, "\n\nDevice approved. Creating a CLI API key...")
	machineName, _ := os.Hostname()
	platform := runtime.GOOS + "/" + runtime.GOARCH
	var exchange exchangeResponse
	if err := api.JSON(ctx, a.HTTPClient, http.MethodPost, host+"/api/v1/cli/auth/exchange", map[string]string{
		"authorization": "Bearer " + accessToken,
	}, map[string]string{
		"machineName": machineName,
		"platform":    platform,
		"cliVersion":  a.Version,
	}, &exchange); err != nil {
		return err
	}
	if err := auth.WriteConfig(auth.Config{
		Host:    host,
		APIKey:  exchange.APIKey,
		KeyID:   exchange.KeyID,
		KeyName: exchange.Name,
		User:    &exchange.User,
	}); err != nil {
		return err
	}
	output.Section(a.Out, "Signed in")
	output.Field(a.Out, "User", exchange.User.Email)
	output.Field(a.Out, "Name", exchange.User.Name)
	output.Field(a.Out, "Host", host)
	key := "created"
	if exchange.KeyID != "" {
		key = output.ShortID(exchange.KeyID)
	}
	output.Field(a.Out, "Key", key)
	return nil
}

func (a *App) runLogs(ctx context.Context, config *auth.Config, value manifest.Manifest, tail int, follow bool) error {
	client := a.client(config)
	result, err := fetchLogs(ctx, client, value, tail, "")
	if err != nil {
		return err
	}
	if a.isMachineOutput() {
		return a.writeData(logsOutput{
			Target:         serviceTargetFromManifest(value),
			LoggingEnabled: result.LoggingEnabled,
			Logs:           result.Logs,
		}, "Logs")
	}
	fmt.Fprintf(a.Out, "%s/%s/%s\n", value.Project, value.Environment, value.Service.Name)
	if !result.LoggingEnabled {
		output.Section(a.Out, "Logs")
		output.Field(a.Out, "Status", "disabled")
		return nil
	}
	if !follow && len(result.Logs) == 0 {
		output.Section(a.Out, "Logs")
		output.Field(a.Out, "Lines", "none")
		return nil
	}
	if !follow {
		output.Section(a.Out, fmt.Sprintf("Logs (%d)", len(result.Logs)))
		printLogs(a.Out, result.Logs)
		return nil
	}
	output.Section(a.Out, "Logs")
	if len(result.Logs) > 0 {
		printLogs(a.Out, result.Logs)
	} else {
		output.Field(a.Out, "Waiting", "new log lines")
	}

	after := getLogCursor(result.Logs)
	if after == "" {
		after = a.Now().UTC().Format(time.RFC3339Nano)
	}
	for {
		a.Sleep(logPollInterval)
		next, err := fetchLogs(ctx, client, value, defaultLogTail, after)
		if err != nil {
			return err
		}
		if len(next.Logs) == 0 {
			continue
		}
		printLogs(a.Out, next.Logs)
		if cursor := getLogCursor(next.Logs); cursor != "" {
			after = cursor
		}
	}
}

func fetchLogs(ctx context.Context, client *api.Client, value manifest.Manifest, tail int, after string) (logsResponse, error) {
	query := manifestIdentityQuery(value)
	query.Set("tail", strconv.Itoa(tail))
	if after != "" {
		query.Set("after", after)
	}
	var result logsResponse
	err := client.RequestJSON(ctx, http.MethodGet, "/api/v1/manifest/logs", query, nil, &result)
	return result, err
}

func manifestIdentityQuery(value manifest.Manifest) url.Values {
	return url.Values{
		"project":     {value.Project},
		"environment": {value.Environment},
		"service":     {value.Service.Name},
	}
}

func printApplyResult(w io.Writer, result applyResponse) {
	output.Section(w, "Apply")
	output.Field(w, "Action", result.Action)
	output.Field(w, "Service", output.ShortID(result.ServiceID))
	if len(result.Changes) == 0 {
		output.Field(w, "Changes", "none")
		return
	}
	output.Section(w, fmt.Sprintf("Changes (%d)", len(result.Changes)))
	for _, change := range result.Changes {
		fmt.Fprintf(w, "  * %s\n", change.Field)
		output.Field(w, "From", change.From)
		output.Field(w, "To", change.To)
	}
}

func printStatus(w io.Writer, value manifest.Manifest, status statusResponse) {
	fmt.Fprintf(w, "%s/%s/%s\n", value.Project, value.Environment, value.Service.Name)
	output.Section(w, "Service")
	output.Field(w, "ID", output.ShortID(status.Service.ID))
	output.Field(w, "Image", status.Service.Image)
	if status.Service.Hostname == nil || *status.Service.Hostname == "" {
		output.Field(w, "Hostname", "none")
	} else {
		output.Field(w, "Hostname", *status.Service.Hostname)
	}
	output.Field(w, "Replicas", status.Service.Replicas)

	output.Section(w, "Rollout")
	if status.LatestRollout != nil {
		output.Field(w, "ID", output.ShortID(status.LatestRollout.ID))
		output.Field(w, "Status", output.Status(status.LatestRollout.Status))
		if status.LatestRollout.CurrentStage != nil && *status.LatestRollout.CurrentStage != "" {
			output.Field(w, "Stage", output.Status(*status.LatestRollout.CurrentStage))
		} else {
			output.Field(w, "Stage", "none")
		}
	} else {
		output.Field(w, "Latest", "none")
	}

	output.Section(w, fmt.Sprintf("Deployments (%d)", len(status.Deployments)))
	if len(status.Deployments) == 0 {
		output.Field(w, "Current", "none")
		return
	}
	for _, deployment := range status.Deployments {
		fmt.Fprintf(w, "  * %s\n", output.ShortID(deployment.ID))
		output.Field(w, "Status", output.Status(deployment.Status))
		output.Field(w, "Server", output.ShortID(deployment.ServerID))
	}
}

func printLogs(w io.Writer, logs []serviceLog) {
	for _, log := range logs {
		stream := log.Stream
		if stream == "" {
			stream = "stdout"
		}
		message := strings.TrimRight(log.Message, "\n")
		fmt.Fprintf(w, "%s %-9s %s\n", output.Timestamp(log.Timestamp), "["+stream+"]", message)
	}
}

func getLogCursor(logs []serviceLog) string {
	var latest string
	var latestTime time.Time
	for _, log := range logs {
		parsed, err := time.Parse(time.RFC3339Nano, log.Timestamp)
		if err != nil {
			continue
		}
		if latest == "" || parsed.After(latestTime) {
			latest = log.Timestamp
			latestTime = parsed
		}
	}
	if latest != "" {
		return latest
	}
	if len(logs) > 0 {
		return logs[len(logs)-1].Timestamp
	}
	return ""
}

func selectFromList[T any](
	reader *bufio.Reader,
	out io.Writer,
	title string,
	items []T,
	render func(T) string,
	disabledReason func(T) string,
) (T, error) {
	var zero T
	if len(items) == 0 {
		return zero, fmt.Errorf("no options available for %q", title)
	}
	for {
		fmt.Fprintf(out, "\n%s\n", title)
		for index, item := range items {
			fmt.Fprintf(out, "  %d. %s\n", index+1, render(item))
		}
		fmt.Fprint(out, "> ")
		line, err := reader.ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return zero, err
		}
		line = strings.TrimSpace(line)
		choice, parseErr := strconv.Atoi(line)
		if parseErr != nil || choice < 1 || choice > len(items) {
			fmt.Fprintln(out, "Enter the number of the option you want.")
			if errors.Is(err, io.EOF) {
				return zero, io.ErrUnexpectedEOF
			}
			continue
		}
		selected := items[choice-1]
		if disabledReason != nil {
			if reason := disabledReason(selected); reason != "" {
				fmt.Fprintln(out, reason)
				if errors.Is(err, io.EOF) {
					return zero, io.ErrUnexpectedEOF
				}
				continue
			}
		}
		return selected, nil
	}
}
