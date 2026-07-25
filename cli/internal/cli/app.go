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
	"os/signal"
	"path/filepath"
	"runtime"
	"slices"
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
	In            io.Reader
	Out           io.Writer
	Err           io.Writer
	HTTPClient    *http.Client
	Sleep         func(time.Duration)
	IsInteractive func() bool
	GetCWD        func() (string, error)
	configStore   auth.ConfigStore
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
		configStore: auth.NewConfigStore(version),
	}
}

func (a *App) Execute() error {
	cmd := a.rootCommand()
	cmd.SetIn(a.In)
	cmd.SetOut(a.Out)
	cmd.SetErr(a.Err)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := cmd.ExecuteContext(ctx); err != nil {
		if a.isMachineOutput() {
			_ = output.Error(a.Out, err)
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
	root.AddCommand(a.projectsCommand())
	root.AddCommand(a.environmentsCommand())
	root.AddCommand(a.servicesCommand())
	root.AddCommand(a.resourceCommand("config", "Show full service configuration", "/configuration", nil, printConfiguration))
	root.AddCommand(a.paginatedCommand("rollouts", "List rollout history", "/rollouts", printRollouts))
	root.AddCommand(a.rolloutCommand())
	root.AddCommand(a.paginatedCommand("builds", "List build history", "/builds", printBuilds))
	root.AddCommand(a.metricsCommand())
	root.AddCommand(a.revisionsCommand())
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
				existing, err := a.configStore.ReadConfig()
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
			if err := a.configStore.DeleteConfig(); err != nil {
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
			config, err := a.requireConfig()
			if err != nil {
				return err
			}
			var response struct {
				User auth.User `json:"user"`
			}
			client := a.client(config)
			if err := client.RequestJSON(cmd.Context(), http.MethodGet, "/api/v1/me", nil, nil, &response); err != nil {
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
project:
  slug: %s
environment:
  name: production
service:
  name: %s
  source:
    type: image
    image: nginx:1.27
  hostname: null
  replicas: 1
  placement:
    mode: automatic
  healthCheck: null
  startCommand: null
  ports:
    - containerPort: 80
      public: false
`, folderName, folderName)
			if err := os.WriteFile(manifestPath, []byte(starter), 0o644); err != nil {
				return err
			}
			if a.isMachineOutput() {
				return a.writeData(initOutput{Manifest: manifestPath, Next: "tc link"}, "Manifest created")
			}
			output.Section(a.Out, "Manifest")
			output.Field(a.Out, "Created", manifestPath)
			output.Next(a.Out, "tc link")
			return nil
		},
	}
}

func (a *App) linkCommand() *cobra.Command {
	var force bool
	var projectID, environmentID, serviceID string
	cmd := &cobra.Command{
		Use:   "link",
		Short: "Create techulus.yml from an existing service",
		Annotations: map[string]string{
			"agent_notes": "Requires an interactive terminal and does not support --agent or --json. Agents should usually pass --project, --environment, and --service to status/logs instead of linking.",
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			if a.isMachineOutput() {
				return errors.New("tc link does not support --agent or --json")
			}
			explicitIDs := 0
			for _, id := range []string{projectID, environmentID, serviceID} {
				if strings.TrimSpace(id) != "" {
					explicitIDs++
				}
			}
			if explicitIDs != 0 && explicitIDs != 3 {
				return errors.New("provide --project, --environment, and --service together")
			}
			if explicitIDs == 0 && !a.IsInteractive() {
				return errors.New("tc link requires an interactive terminal or all ID flags")
			}
			config, err := a.requireConfig()
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
			ps, err := fetchAllProjects(cmd.Context(), client)
			if err != nil {
				return err
			}
			if len(ps.Projects) == 0 {
				return errors.New("no projects found")
			}
			reader := bufio.NewReader(a.In)
			var project projectItem
			if projectID != "" {
				for _, v := range ps.Projects {
					if v.ID == projectID {
						project = v
					}
				}
				if project.ID == "" {
					return errors.New("project ID not found")
				}
			} else {
				project, err = selectFromList(reader, a.Out, "Select a project:", ps.Projects, func(v projectItem) string { return v.Name })
				if err != nil {
					return err
				}
			}
			ep := "/api/v1/projects/" + url.PathEscape(project.ID) + "/environments"
			es, err := fetchAllEnvironments(cmd.Context(), client, ep)
			if err != nil {
				return err
			}
			var environment environmentItem
			if environmentID != "" {
				for _, v := range es.Environments {
					if v.ID == environmentID {
						environment = v
					}
				}
				if environment.ID == "" {
					return errors.New("environment ID not found")
				}
			} else {
				environment, err = selectFromList(reader, a.Out, "Select an environment:", es.Environments, func(v environmentItem) string { return v.Name })
				if err != nil {
					return err
				}
			}
			sp := ep + "/" + url.PathEscape(environment.ID) + "/services"
			ss, err := fetchAllServices(cmd.Context(), client, sp)
			if err != nil {
				return err
			}
			var service serviceItem
			if serviceID != "" {
				for _, v := range ss.Services {
					if v.ID == serviceID {
						service = v
					}
				}
				if service.ID == "" {
					return errors.New("service ID not found")
				}
			} else {
				service, err = selectFromList(reader, a.Out, "Select a service:", ss.Services, func(v serviceItem) string { return v.Name })
				if err != nil {
					return err
				}
			}
			var cfg struct {
				Current struct {
					Hostname *string `json:"hostname"`
					Ports    []struct {
						ContainerPort int     `json:"containerPort"`
						IsPublic      bool    `json:"public"`
						Domain        *string `json:"domain"`
					} `json:"ports"`
					Replicas  int `json:"replicas"`
					Placement *struct {
						Mode string `json:"mode"`
					} `json:"placement"`
					Placements []struct {
						ServerID string `json:"serverId"`
						Count    int    `json:"count"`
					} `json:"placements"`
					HealthCheck  *manifest.HealthCheck `json:"healthCheck"`
					StartCommand *string               `json:"startCommand"`
					Resources    *manifest.Resources   `json:"resources"`
				} `json:"current"`
				Management *struct {
					Patchable bool `json:"patchable"`
					Blockers  []struct {
						Code    string `json:"code"`
						Message string `json:"message"`
					} `json:"blockers"`
				} `json:"management"`
			}
			base := sp + "/" + url.PathEscape(service.ID)
			if err := client.RequestJSON(cmd.Context(), http.MethodGet, base+"/configuration", nil, nil, &cfg); err != nil {
				return err
			}
			if cfg.Management == nil {
				return errors.New("configuration response did not include service management compatibility")
			}
			if !cfg.Management.Patchable {
				if len(cfg.Management.Blockers) > 0 && cfg.Management.Blockers[0].Message != "" {
					return errors.New(cfg.Management.Blockers[0].Message)
				}
				return errors.New("this service cannot be managed with techulus.yml")
			}
			if cfg.Current.Resources != nil && cfg.Current.Resources.CPUCores == nil && cfg.Current.Resources.MemoryMB == nil {
				cfg.Current.Resources = nil
			}
			ports := make([]manifest.Port, len(cfg.Current.Ports))
			for i, p := range cfg.Current.Ports {
				ports[i] = manifest.Port{ContainerPort: p.ContainerPort, Public: p.IsPublic, Domain: p.Domain}
			}
			var placement *manifest.Placement
			if cfg.Current.Placement != nil {
				if cfg.Current.Placement.Mode == "automatic" {
					placement = &manifest.Placement{Mode: "automatic"}
				} else if len(cfg.Current.Placements) == 0 {
					return errors.New("configure at least one server placement in the web UI before linking this service")
				} else {
					placement = &manifest.Placement{Mode: "manual"}
					placement.Servers = make([]manifest.PlacementServer, len(cfg.Current.Placements))
					for i, p := range cfg.Current.Placements {
						placement.Servers[i] = manifest.PlacementServer{ServerID: p.ServerID, Count: p.Count}
					}
				}
			}
			m := manifest.Manifest{APIVersion: "v1", Project: manifest.Project{ID: project.ID, Slug: project.Slug}, Environment: manifest.Environment{ID: environment.ID, Name: environment.Name}, Service: manifest.Service{ID: service.ID, Name: service.Name, Source: service.Source, Hostname: cfg.Current.Hostname, Ports: ports, Replicas: cfg.Current.Replicas, Placement: placement, HealthCheck: cfg.Current.HealthCheck, StartCommand: cfg.Current.StartCommand, Resources: cfg.Current.Resources}}
			if err := manifest.Save(manifestPath, m); err != nil {
				return err
			}
			output.Section(a.Out, "Linked")
			output.Field(a.Out, "Service", fmt.Sprintf("%s/%s/%s", project.Slug, environment.Name, service.Name))
			output.Field(a.Out, "Manifest", manifestPath)
			output.Next(a.Out, "tc status  or  tc apply")
			return nil
		},
	}
	cmd.Flags().BoolVar(&force, "force", false, "Replace an existing techulus.yml")
	cmd.Flags().StringVar(&projectID, "project", "", "Project ID")
	cmd.Flags().StringVar(&environmentID, "environment", "", "Environment ID")
	cmd.Flags().StringVar(&serviceID, "service", "", "Service ID")
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
			config, err := a.requireConfig()
			if err != nil {
				return err
			}
			loaded, err := a.ensureManifest()
			if err != nil {
				return err
			}
			var result applyResponse
			client := a.client(config)
			if !loaded.Manifest.Linked() {
				return errors.New("service is not linked: run `tc link`")
			}
			placement := loaded.Manifest.Service.Placement
			if placement == nil {
				return errors.New("service.placement is required")
			}
			body := map[string]any{"source": sourcePatch(loaded.Manifest.Service.Source), "hostname": loaded.Manifest.Service.Hostname, "ports": loaded.Manifest.Service.Ports, "healthCheck": loaded.Manifest.Service.HealthCheck, "startCommand": loaded.Manifest.Service.StartCommand}
			if placement.Mode == "automatic" {
				body["placement"] = map[string]any{"mode": "automatic", "replicas": loaded.Manifest.Service.Replicas}
			} else {
				body["placement"] = map[string]any{"mode": "manual", "placements": placement.Servers}
			}
			if loaded.Manifest.Service.Resources != nil {
				body["resources"] = loaded.Manifest.Service.Resources
			}
			if err := client.RequestJSON(cmd.Context(), http.MethodPatch, serviceBase(loaded.Manifest)+"/configuration", nil, body, &result); err != nil {
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
			config, err := a.requireConfig()
			if err != nil {
				return err
			}
			loaded, err := a.ensureManifest()
			if err != nil {
				return err
			}
			var result deployResponse
			client := a.client(config)
			if !loaded.Manifest.Linked() {
				return errors.New("service is not linked: run `tc link`")
			}
			var persisted struct {
				Current struct {
					Source manifest.Source `json:"source"`
				} `json:"current"`
			}
			if err := client.RequestJSON(cmd.Context(), http.MethodGet, serviceBase(loaded.Manifest)+"/configuration", nil, nil, &persisted); err != nil {
				return err
			}
			if !sourcesEqual(loaded.Manifest.Service.Source, persisted.Current.Source) {
				return errors.New("service source differs from techulus.yml: run `tc apply` before deploying")
			}
			if err := client.RequestJSON(cmd.Context(), http.MethodPost, serviceBase(loaded.Manifest)+"/deploy", nil, nil, &result); err != nil {
				return err
			}
			if a.isMachineOutput() {
				return a.writeData(result, "Deploy")
			}
			output.Section(a.Out, "Deploy")
			output.Field(a.Out, "Operation", result.Operation)
			output.Field(a.Out, "Status", output.Status(result.Status))
			if result.RolloutID != nil && *result.RolloutID != "" {
				output.Field(a.Out, "Rollout", output.ShortID(*result.RolloutID))
			}
			if result.Operation == "build" {
				output.Field(a.Out, "Next", "build queued; a rollout starts after it succeeds")
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
			config, err := a.requireConfig()
			if err != nil {
				return err
			}
			value, err := a.resolveServiceTarget(target)
			if err != nil {
				return err
			}
			var status statusResponse
			client := a.client(config)
			if err := client.RequestJSON(cmd.Context(), http.MethodGet, serviceBase(value)+"/status", nil, nil, &status); err != nil {
				return err
			}
			if a.isMachineOutput() {
				return a.writeData(status, "Status")
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
	var query, logRange string
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
			if a.isMachineOutput() {
				if cmd.Flags().Changed("follow") && follow {
					return errors.New("--follow=true is not supported with --agent or --json")
				}
				follow = false
			}
			config, err := a.requireConfig()
			if err != nil {
				return err
			}
			value, err := a.resolveServiceTarget(target)
			if err != nil {
				return err
			}
			if logRange != "" && !slices.Contains([]string{"1h", "6h", "24h", "7d"}, logRange) {
				return errors.New("invalid log range")
			}
			return a.runLogs(cmd.Context(), config, value, tail, follow, query, logRange)
		},
	}
	cmd.Flags().IntVarP(&tail, "tail", "n", defaultLogTail, "Number of log lines to fetch")
	cmd.Flags().BoolVar(&follow, "follow", true, "Continue polling for new log lines")
	cmd.Flags().StringVarP(&query, "query", "q", "", "Search log messages")
	cmd.Flags().StringVar(&logRange, "range", "", "Time range (1h, 6h, 24h, 7d)")
	addServiceTargetFlags(cmd, &target)
	return cmd
}

func (a *App) projectsCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "projects",
		Short: "List projects",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := a.requireConfig()
			if err != nil {
				return err
			}
			out, err := fetchAllProjects(cmd.Context(), a.client(cfg))
			if err != nil {
				return err
			}
			if a.isMachineOutput() {
				return a.writeData(out, "Projects")
			}
			output.Section(a.Out, "Projects")
			for _, v := range out.Projects {
				fmt.Fprintf(a.Out, "  %s  %s  %s\n", v.ID, v.Name, v.Slug)
			}
			return nil
		},
	}
}

func (a *App) environmentsCommand() *cobra.Command {
	var id string
	c := &cobra.Command{Use: "environments", Short: "List project environments", RunE: func(cmd *cobra.Command, args []string) error {
		cfg, e := a.requireConfig()
		if e != nil {
			return e
		}
		if id == "" {
			if l, x := a.ensureManifest(); x == nil {
				id = l.Manifest.Project.ID
			}
		}
		if id == "" {
			return errors.New("missing --project (or link this directory)")
		}
		out, e := fetchAllEnvironments(cmd.Context(), a.client(cfg), "/api/v1/projects/"+url.PathEscape(id)+"/environments")
		if e != nil {
			return e
		}
		if a.isMachineOutput() {
			return a.writeData(out, "Environments")
		}
		output.Section(a.Out, "Environments")
		for _, v := range out.Environments {
			fmt.Fprintf(a.Out, "  %s  %s\n", v.ID, v.Name)
		}
		return nil
	}}
	c.Flags().StringVar(&id, "project", "", "Project ID")
	return c
}
func (a *App) servicesCommand() *cobra.Command {
	var p, eid string
	c := &cobra.Command{Use: "services", Short: "List environment services", RunE: func(cmd *cobra.Command, args []string) error {
		cfg, e := a.requireConfig()
		if e != nil {
			return e
		}
		if p == "" || eid == "" {
			if l, x := a.ensureManifest(); x == nil {
				if p == "" {
					p = l.Manifest.Project.ID
				}
				if eid == "" {
					eid = l.Manifest.Environment.ID
				}
			}
		}
		if p == "" || eid == "" {
			return errors.New("missing --project and --environment (or link this directory)")
		}
		path := "/api/v1/projects/" + url.PathEscape(p) + "/environments/" + url.PathEscape(eid) + "/services"
		out, e := fetchAllServices(cmd.Context(), a.client(cfg), path)
		if e != nil {
			return e
		}
		if a.isMachineOutput() {
			return a.writeData(out, "Services")
		}
		output.Section(a.Out, "Services")
		for _, v := range out.Services {
			fmt.Fprintf(a.Out, "  %s  %s  %s\n", v.ID, v.Name, v.Source.Type)
		}
		return nil
	}}
	c.Flags().StringVar(&p, "project", "", "Project ID")
	c.Flags().StringVar(&eid, "environment", "", "Environment ID")
	return c
}
func (a *App) resourceCommand(name, short, suffix string, q func(*cobra.Command) url.Values, print func(io.Writer, map[string]any)) *cobra.Command {
	var target serviceTargetFlags
	c := &cobra.Command{Use: name, Short: short, RunE: func(cmd *cobra.Command, args []string) error {
		cfg, e := a.requireConfig()
		if e != nil {
			return e
		}
		m, e := a.resolveServiceTarget(target)
		if e != nil {
			return e
		}
		query := url.Values{}
		if q != nil {
			query = q(cmd)
		}
		var out map[string]any
		if e = a.client(cfg).RequestJSON(cmd.Context(), http.MethodGet, serviceBase(m)+suffix, query, nil, &out); e != nil {
			return e
		}
		label := strings.ToUpper(name[:1]) + name[1:]
		if a.isMachineOutput() {
			return a.writeData(out, label)
		}
		if print == nil {
			return fmt.Errorf("%s command does not define human output formatting", name)
		}
		print(a.Out, out)
		return nil
	}}
	addServiceTargetFlags(c, &target)
	return c
}
func (a *App) paginatedCommand(name, short, suffix string, print func(io.Writer, map[string]any)) *cobra.Command {
	var limit int
	var cursor string
	c := a.resourceCommand(name, short, suffix, func(*cobra.Command) url.Values {
		q := url.Values{"limit": {strconv.Itoa(limit)}}
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		return q
	}, print)
	c.Flags().IntVar(&limit, "limit", 25, "Items (1-100)")
	c.Flags().StringVar(&cursor, "cursor", "", "Pagination cursor")
	c.PreRunE = func(*cobra.Command, []string) error {
		if limit < 1 || limit > 100 {
			return errors.New("limit must be between 1 and 100")
		}
		return nil
	}
	return c
}
func (a *App) rolloutCommand() *cobra.Command {
	var target serviceTargetFlags
	c := &cobra.Command{Use: "rollout <rolloutId>", Short: "Show rollout detail", Args: cobra.ExactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		return a.getRolloutResource(cmd, target, args[0], false, "", 100)
	}}
	c.PersistentFlags().StringVar(&target.Project, "project", "", "Project ID")
	c.PersistentFlags().StringVar(&target.Environment, "environment", "", "Environment ID")
	c.PersistentFlags().StringVar(&target.Service, "service", "", "Service ID")
	var q string
	var limit int
	logs := &cobra.Command{Use: "logs <rolloutId>", Short: "Show rollout logs", Args: cobra.ExactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		if limit < 1 || limit > 1000 {
			return errors.New("limit must be between 1 and 1000")
		}
		return a.getRolloutResource(cmd, target, args[0], true, q, limit)
	}}
	logs.Flags().StringVarP(&q, "query", "q", "", "Search logs")
	logs.Flags().IntVar(&limit, "limit", 100, "Log lines")
	c.AddCommand(logs)
	return c
}
func (a *App) getRolloutResource(cmd *cobra.Command, t serviceTargetFlags, id string, logs bool, q string, limit int) error {
	cfg, e := a.requireConfig()
	if e != nil {
		return e
	}
	m, e := a.resolveServiceTarget(t)
	if e != nil {
		return e
	}
	suffix := "/rollouts/" + url.PathEscape(id)
	query := url.Values{}
	if logs {
		suffix += "/logs"
		query.Set("limit", strconv.Itoa(limit))
		if q != "" {
			query.Set("q", q)
		}
	}
	var out map[string]any
	if e = a.client(cfg).RequestJSON(cmd.Context(), http.MethodGet, serviceBase(m)+suffix, query, nil, &out); e != nil {
		return e
	}
	if a.isMachineOutput() {
		return a.writeData(out, "Rollout")
	}
	if logs {
		printRolloutLogs(a.Out, out)
	} else {
		printRolloutDetail(a.Out, out)
	}
	return nil
}
func (a *App) metricsCommand() *cobra.Command {
	var r string
	c := a.resourceCommand("metrics", "Show service metrics", "/metrics", func(*cobra.Command) url.Values { return url.Values{"range": {r}} }, printMetrics)
	c.Flags().StringVar(&r, "range", "1h", "Range: 1h, 6h, 24h, 7d, 30d")
	c.PreRunE = func(*cobra.Command, []string) error {
		if !slices.Contains([]string{"1h", "6h", "24h", "7d", "30d"}, r) {
			return errors.New("invalid metrics range")
		}
		return nil
	}
	return c
}
func (a *App) revisionsCommand() *cobra.Command {
	var cursor string
	c := a.resourceCommand("revisions", "List service revisions", "/revisions", func(*cobra.Command) url.Values {
		q := url.Values{}
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		return q
	}, printRevisions)
	c.Flags().StringVar(&cursor, "cursor", "", "Pagination cursor")
	return c
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
		if strings.Contains(name, "|") {
			arg.Name = "shell"
			arg.Choices = strings.Split(name, "|")
		}
		args = append(args, arg)
	}
	return args
}

type serviceTargetFlags struct {
	Project     string
	Environment string
	Service     string
}

func addServiceTargetFlags(cmd *cobra.Command, target *serviceTargetFlags) {
	cmd.Flags().StringVar(&target.Project, "project", "", "Project ID")
	cmd.Flags().StringVar(&target.Environment, "environment", "", "Environment ID")
	cmd.Flags().StringVar(&target.Service, "service", "", "Service ID")
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
		if !loaded.Manifest.Linked() {
			return manifest.Manifest{}, errors.New("service is not linked: run `tc link`")
		}
		return loaded.Manifest, nil
	}
	if explicitCount != 3 {
		return manifest.Manifest{}, errors.New("provide --project, --environment, and --service together")
	}
	return manifest.Manifest{
		APIVersion:  "v1",
		Project:     manifest.Project{ID: project, Slug: project},
		Environment: manifest.Environment{ID: environment, Name: environment},
		Service: manifest.Service{
			ID: service, Name: service,
		},
	}, nil
}

func serviceBase(value manifest.Manifest) string {
	return "/api/v1/projects/" + url.PathEscape(value.Project.ID) + "/environments/" + url.PathEscape(value.Environment.ID) + "/services/" + url.PathEscape(value.Service.ID)
}

func sourcePatch(source manifest.Source) map[string]any {
	if source.Type == "image" {
		return map[string]any{"type": "image", "image": source.Image}
	}
	return map[string]any{
		"type":       "github",
		"repository": source.Repository,
		"branch":     source.Branch,
		"rootDir":    source.RootDir,
	}
}

func pageQuery(cursor string) url.Values {
	query := url.Values{"limit": {"100"}}
	if cursor != "" {
		query.Set("cursor", cursor)
	}
	return query
}

func fetchAllProjects(ctx context.Context, client *api.Client) (projectsResponse, error) {
	var result projectsResponse
	cursor := ""
	seen := map[string]struct{}{}
	for {
		var page projectsResponse
		if err := client.RequestJSON(ctx, http.MethodGet, "/api/v1/projects", pageQuery(cursor), nil, &page); err != nil {
			return projectsResponse{}, err
		}
		result.Projects = append(result.Projects, page.Projects...)
		if page.NextCursor == "" {
			return result, nil
		}
		if _, exists := seen[page.NextCursor]; exists {
			return projectsResponse{}, errors.New("projects API returned a repeated pagination cursor")
		}
		seen[page.NextCursor] = struct{}{}
		cursor = page.NextCursor
	}
}

func fetchAllEnvironments(ctx context.Context, client *api.Client, path string) (environmentsResponse, error) {
	var result environmentsResponse
	cursor := ""
	seen := map[string]struct{}{}
	for {
		var page environmentsResponse
		if err := client.RequestJSON(ctx, http.MethodGet, path, pageQuery(cursor), nil, &page); err != nil {
			return environmentsResponse{}, err
		}
		result.Environments = append(result.Environments, page.Environments...)
		if page.NextCursor == "" {
			return result, nil
		}
		if _, exists := seen[page.NextCursor]; exists {
			return environmentsResponse{}, errors.New("environments API returned a repeated pagination cursor")
		}
		seen[page.NextCursor] = struct{}{}
		cursor = page.NextCursor
	}
}

func fetchAllServices(ctx context.Context, client *api.Client, path string) (servicesResponse, error) {
	var result servicesResponse
	cursor := ""
	seen := map[string]struct{}{}
	for {
		var page servicesResponse
		if err := client.RequestJSON(ctx, http.MethodGet, path, pageQuery(cursor), nil, &page); err != nil {
			return servicesResponse{}, err
		}
		result.Services = append(result.Services, page.Services...)
		if page.NextCursor == "" {
			return result, nil
		}
		if _, exists := seen[page.NextCursor]; exists {
			return servicesResponse{}, errors.New("services API returned a repeated pagination cursor")
		}
		seen[page.NextCursor] = struct{}{}
		cursor = page.NextCursor
	}
}

func sourcesEqual(expected, actual manifest.Source) bool {
	if expected.Type != actual.Type {
		return false
	}
	if expected.Type == "image" {
		return expected.Image == actual.Image
	}
	if !strings.EqualFold(expected.Repository, actual.Repository) || expected.Branch != actual.Branch {
		return false
	}
	if expected.RootDir == nil || actual.RootDir == nil {
		return expected.RootDir == nil && actual.RootDir == nil
	}
	return *expected.RootDir == *actual.RootDir
}

func (a *App) requireConfig() (*auth.Config, error) {
	config, err := a.configStore.ReadConfig()
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
	expiresAt := time.Now().Add(time.Duration(deviceCode.ExpiresIn) * time.Second)
	var accessToken string
	for accessToken == "" {
		if deviceCode.ExpiresIn > 0 && !time.Now().Before(expiresAt) {
			return errors.New("device authorization expired")
		}
		if err := a.sleep(ctx, interval); err != nil {
			return err
		}
		if deviceCode.ExpiresIn > 0 && !time.Now().Before(expiresAt) {
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
	if err := api.JSON(ctx, a.HTTPClient, http.MethodPost, host+"/api/v1/api-keys", map[string]string{
		"authorization": "Bearer " + accessToken,
	}, map[string]any{
		"name":     cliAPIKeyName(machineName),
		"metadata": map[string]string{"machineName": machineName, "platform": platform, "cliVersion": a.Version},
	}, &exchange); err != nil {
		return err
	}
	if err := a.configStore.WriteConfig(auth.Config{
		Host:    host,
		APIKey:  exchange.APIKey,
		KeyID:   exchange.KeyID,
		KeyName: exchange.Name,
	}); err != nil {
		return err
	}
	output.Section(a.Out, "Signed in")
	output.Field(a.Out, "Host", host)
	key := "created"
	if exchange.KeyID != "" {
		key = output.ShortID(exchange.KeyID)
	}
	output.Field(a.Out, "Key", key)
	return nil
}

func cliAPIKeyName(machineName string) string {
	name := strings.TrimSpace("CLI " + machineName)
	runes := []rune(name)
	if len(runes) > 32 {
		name = string(runes[:32])
	}
	return name
}

func (a *App) runLogs(ctx context.Context, config *auth.Config, value manifest.Manifest, tail int, follow bool, search, logRange string) error {
	client := a.client(config)
	result, err := fetchLogs(ctx, client, value, tail, "", search, logRange)
	if err != nil {
		return err
	}
	if a.isMachineOutput() {
		return a.writeData(result, "Logs")
	}
	fmt.Fprintf(a.Out, "%s/%s/%s\n", value.Project.Slug, value.Environment.Name, value.Service.Name)
	if result.Provider == "disabled" {
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

	cursor := result.NextCursor
	if cursor == "" {
		return fmt.Errorf("logs API did not return nextCursor")
	}
	for {
		next, err := fetchLogs(ctx, client, value, defaultLogTail, cursor, search, logRange)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return nil
			}
			return err
		}
		if len(next.Logs) > 0 {
			printLogs(a.Out, next.Logs)
		}
		if next.NextCursor == "" {
			return fmt.Errorf("logs API did not return nextCursor")
		}
		cursor = next.NextCursor
		if next.HasMore {
			continue
		}
		d := time.Duration(next.PollAfterMS) * time.Millisecond
		if d <= 0 {
			d = logPollInterval
		}
		if err := a.sleep(ctx, d); err != nil {
			if errors.Is(err, context.Canceled) {
				return nil
			}
			return err
		}
	}
}

func (a *App) sleep(ctx context.Context, duration time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if a.Sleep != nil {
		a.Sleep(duration)
		return ctx.Err()
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func fetchLogs(ctx context.Context, client *api.Client, value manifest.Manifest, tail int, cursor, search, logRange string) (logsResponse, error) {
	query := url.Values{}
	query.Set("tail", strconv.Itoa(tail))
	if search != "" {
		query.Set("q", search)
	}
	if logRange != "" {
		query.Set("range", logRange)
	}
	if cursor != "" {
		query.Set("cursor", cursor)
		query.Set("wait", "20")
	}
	var result logsResponse
	err := client.RequestJSON(ctx, http.MethodGet, serviceBase(value)+"/logs", query, nil, &result)
	return result, err
}

func printApplyResult(w io.Writer, result applyResponse) {
	output.Section(w, "Apply")
	output.Field(w, "Action", result.Action)
	if len(result.Changes) == 0 {
		output.Field(w, "Changes", "none")
		return
	}
	output.Section(w, fmt.Sprintf("Changes (%d)", len(result.Changes)))
	for _, change := range result.Changes {
		fmt.Fprintf(w, "  * %s\n", change)
	}
}

func printStatus(w io.Writer, value manifest.Manifest, status statusResponse) {
	fmt.Fprintf(w, "%s/%s/%s\n", value.Project.Slug, value.Environment.Name, value.Service.Name)
	output.Section(w, "Service")
	output.Field(w, "ID", output.ShortID(status.Service.ID))
	if status.Service.Source.Type == "image" {
		output.Field(w, "Source", status.Service.Source.Image)
	} else {
		output.Field(w, "Source", status.Service.Source.Repository+" @ "+status.Service.Source.Branch)
	}
	output.Section(w, "Build")
	if status.LatestBuild == nil {
		output.Field(w, "Latest", "none")
	} else {
		printMapSummary(w, status.LatestBuild)
	}

	output.Section(w, "Rollout")
	if status.LatestRollout != nil {
		printMapSummary(w, status.LatestRollout)
	} else {
		output.Field(w, "Latest", "none")
	}

	output.Section(w, fmt.Sprintf("Deployments (%d)", len(status.Deployments)))
	if len(status.Deployments) == 0 {
		output.Field(w, "Current", "none")
		return
	}
	for _, deployment := range status.Deployments {
		printMapSummary(w, deployment)
	}
}

func printMapSummary(w io.Writer, m map[string]any) {
	for _, k := range []string{"id", "status", "phase", "currentStage", "serverName", "createdAt"} {
		if v, ok := m[k]; ok && v != nil {
			output.Field(w, k, v)
		}
	}
}

func printBuilds(w io.Writer, result map[string]any) {
	if supported, ok := result["supported"].(bool); ok && !supported {
		output.Section(w, "Builds")
		output.Field(w, "Status", "not supported")
		output.Field(w, "Reason", "image-source services use pre-built images")
		return
	}

	builds, _ := result["builds"].([]any)
	output.Section(w, fmt.Sprintf("Builds (%d)", len(builds)))
	if len(builds) == 0 {
		output.Field(w, "Items", "none")
	} else {
		for i, value := range builds {
			build, ok := value.(map[string]any)
			if !ok {
				continue
			}
			if i > 0 {
				fmt.Fprintln(w)
			}
			for _, field := range []struct {
				key, label string
			}{
				{"id", "ID"},
				{"status", "Status"},
				{"branch", "Branch"},
				{"commitSha", "Commit"},
				{"commitMessage", "Message"},
				{"author", "Author"},
				{"targetPlatform", "Platform"},
				{"startedAt", "Started"},
				{"completedAt", "Completed"},
				{"createdAt", "Created"},
			} {
				value, ok := build[field.key].(string)
				if !ok || value == "" {
					continue
				}
				switch field.key {
				case "id", "commitSha":
					value = output.ShortID(value)
				case "status":
					value = output.Status(value)
				case "startedAt", "completedAt", "createdAt":
					value = output.Timestamp(value)
				}
				output.Field(w, field.label, value)
			}
		}
	}
	if cursor, ok := result["nextCursor"].(string); ok && cursor != "" {
		output.Field(w, "Next", cursor)
	}
}

func printConfiguration(w io.Writer, result map[string]any) {
	output.Section(w, "Configuration")
	current, ok := result["current"].(map[string]any)
	if !ok {
		output.Field(w, "Status", "unavailable")
		return
	}

	if source, ok := current["source"].(map[string]any); ok {
		output.Field(w, "Source", formatSource(source))
	}
	printOptionalField(w, "Hostname", current["hostname"])
	printOptionalField(w, "Stateful", current["stateful"])
	printOptionalField(w, "Replicas", current["replicas"])
	printOptionalField(w, "Start", current["startCommand"])
	if resources, ok := current["resources"].(map[string]any); ok {
		if cpu, ok := metricNumber(resources["cpuCores"]); ok {
			output.Field(w, "CPU limit", formatMetric(cpu, " cores"))
		} else {
			output.Field(w, "CPU limit", "no limit")
		}
		if memory, ok := metricNumber(resources["memoryMb"]); ok {
			output.Field(w, "Memory", formatMetric(memory, " MB"))
		} else {
			output.Field(w, "Memory", "no limit")
		}
	}

	printPlacements(w, current["placements"])
	printPorts(w, current["ports"])
	printVolumes(w, current["volumes"])
	printHealthCheck(w, current["healthCheck"])
	printServerless(w, current["serverless"])
	printSchedules(w, current["schedules"])

	output.Section(w, "Deployment")
	printOptionalField(w, "Revision", shortIDValue(result["activeRevisionId"]))
	printOptionalField(w, "Deployment", shortIDValue(result["activeDeploymentId"]))
	printOptionalField(w, "Pending", result["hasPendingChanges"])
	changes, _ := result["changes"].([]any)
	if len(changes) > 0 {
		output.Field(w, "Changes", len(changes))
		for _, value := range changes {
			change, ok := value.(map[string]any)
			if !ok {
				continue
			}
			fmt.Fprintf(w, "    * %v: %v -> %v\n", change["field"], change["from"], change["to"])
		}
	} else {
		output.Field(w, "Changes", "none")
	}

	if management, ok := result["management"].(map[string]any); ok {
		output.Section(w, "Management")
		printOptionalField(w, "Patchable", management["patchable"])
		blockers, _ := management["blockers"].([]any)
		for _, value := range blockers {
			blocker, ok := value.(map[string]any)
			if !ok {
				continue
			}
			fmt.Fprintf(w, "    * %v\n", blocker["message"])
		}
	}
}

func formatSource(source map[string]any) string {
	switch source["type"] {
	case "image":
		if image, ok := source["image"].(string); ok {
			return image
		}
	case "github":
		repository, _ := source["repository"].(string)
		branch, _ := source["branch"].(string)
		value := repository
		if branch != "" {
			value += " @ " + branch
		}
		if root, ok := source["rootDir"].(string); ok && root != "" {
			value += " (" + root + ")"
		}
		return value
	}
	return "unknown"
}

func printOptionalField(w io.Writer, label string, value any) {
	switch value := value.(type) {
	case nil:
		output.Field(w, label, "none")
	case bool:
		if value {
			output.Field(w, label, "yes")
		} else {
			output.Field(w, label, "no")
		}
	case string:
		if value == "" {
			output.Field(w, label, "none")
		} else {
			output.Field(w, label, value)
		}
	default:
		output.Field(w, label, value)
	}
}

func shortIDValue(value any) any {
	if id, ok := value.(string); ok && id != "" {
		return output.ShortID(id)
	}
	return nil
}

func printPlacements(w io.Writer, value any) {
	placements, _ := value.([]any)
	output.Field(w, "Placements", len(placements))
	for _, value := range placements {
		placement, ok := value.(map[string]any)
		if !ok {
			continue
		}
		server := placement["serverName"]
		if server == nil {
			server = shortIDValue(placement["serverId"])
		}
		fmt.Fprintf(w, "    * %v: %v replica(s)\n", server, placement["count"])
	}
}

func printPorts(w io.Writer, value any) {
	ports, _ := value.([]any)
	output.Field(w, "Ports", len(ports))
	for _, value := range ports {
		port, ok := value.(map[string]any)
		if !ok {
			continue
		}
		protocol, _ := port["protocol"].(string)
		line := fmt.Sprintf("%v/%s", port["containerPort"], protocol)
		if public, _ := port["public"].(bool); public {
			line += " public"
			if domain, ok := port["domain"].(string); ok && domain != "" {
				line += " (" + domain + ")"
			} else if external := port["externalPort"]; external != nil {
				line += fmt.Sprintf(" (external %v)", external)
			}
		}
		fmt.Fprintf(w, "    * %s\n", line)
	}
}

func printVolumes(w io.Writer, value any) {
	volumes, _ := value.([]any)
	output.Field(w, "Volumes", len(volumes))
	for _, value := range volumes {
		volume, ok := value.(map[string]any)
		if ok {
			fmt.Fprintf(w, "    * %v: %v\n", volume["name"], volume["containerPath"])
		}
	}
}

func printHealthCheck(w io.Writer, value any) {
	health, ok := value.(map[string]any)
	if !ok {
		output.Field(w, "Health", "none")
		return
	}
	output.Field(w, "Health", health["cmd"])
	fmt.Fprintf(w, "    interval %vs, timeout %vs, retries %v, start period %vs\n", health["interval"], health["timeout"], health["retries"], health["startPeriod"])
}

func printServerless(w io.Writer, value any) {
	serverless, ok := value.(map[string]any)
	if !ok {
		return
	}
	enabled, _ := serverless["enabled"].(bool)
	if !enabled {
		output.Field(w, "Serverless", "disabled")
		return
	}
	output.Field(w, "Serverless", "enabled")
	fmt.Fprintf(w, "    sleep after %vs, wake timeout %vs\n", serverless["sleepAfterSeconds"], serverless["wakeTimeoutSeconds"])
}

func printSchedules(w io.Writer, value any) {
	schedules, ok := value.(map[string]any)
	if !ok {
		return
	}
	printOptionalField(w, "Deploy cron", schedules["deployment"])
	if backup, ok := schedules["backup"].(map[string]any); ok {
		enabled, _ := backup["enabled"].(bool)
		if enabled {
			printOptionalField(w, "Backup cron", backup["schedule"])
		} else {
			output.Field(w, "Backups", "disabled")
		}
	}
}

func printMetrics(w io.Writer, result map[string]any) {
	output.Section(w, "Metrics")
	if result["provider"] == "disabled" {
		output.Field(w, "Status", "disabled")
		return
	}

	metrics, ok := result["metrics"].(map[string]any)
	if !ok {
		output.Field(w, "Status", "unavailable")
		return
	}
	for _, field := range []struct {
		key, label string
	}{
		{"range", "Range"},
		{"windowStart", "From"},
		{"windowEnd", "To"},
		{"totalRequests", "Requests"},
	} {
		if value, ok := metrics[field.key]; ok && value != nil {
			if field.key == "totalRequests" {
				if count, ok := metricNumber(value); ok {
					value = formatMetric(count, "")
				}
			}
			output.Field(w, field.label, value)
		}
	}
	if value, ok := metricNumber(metrics["totalIngressBytes"]); ok {
		output.Field(w, "Ingress", formatBytes(value))
	}
	if value, ok := metricNumber(metrics["totalEgressBytes"]); ok {
		output.Field(w, "Egress", formatBytes(value))
	}

	buckets, _ := metrics["buckets"].([]any)
	if len(buckets) == 0 {
		output.Field(w, "Samples", "none")
		return
	}
	latest, ok := buckets[len(buckets)-1].(map[string]any)
	if !ok {
		return
	}
	output.Section(w, "Latest sample")
	if value, ok := latest["timestamp"]; ok {
		output.Field(w, "Time", value)
	}
	if value, ok := latest["totalRequests"]; ok {
		if count, ok := metricNumber(value); ok {
			value = formatMetric(count, "")
		}
		output.Field(w, "Requests", value)
	}
	if value, ok := metricNumber(latest["cpuUsagePercent"]); ok {
		output.Field(w, "CPU", formatMetric(value, "%"))
	}
	if value, ok := metricNumber(latest["memoryUsagePercent"]); ok {
		memory := formatMetric(value, "%")
		if bytes, ok := metricNumber(latest["memoryUsedBytes"]); ok {
			memory += " (" + formatBytes(bytes) + ")"
		}
		output.Field(w, "Memory", memory)
	}
	for _, field := range []struct {
		key, label, suffix string
	}{
		{"p50ResponseTimeMs", "P50 latency", " ms"},
		{"p90ResponseTimeMs", "P90 latency", " ms"},
		{"p95ResponseTimeMs", "P95 latency", " ms"},
		{"p99ResponseTimeMs", "P99 latency", " ms"},
		{"ingressBytesPerSecond", "Ingress/s", " B/s"},
		{"egressBytesPerSecond", "Egress/s", " B/s"},
	} {
		if value, ok := metricNumber(latest[field.key]); ok {
			output.Field(w, field.label, formatMetric(value, field.suffix))
		}
	}
}

func metricNumber(value any) (float64, bool) {
	number, ok := value.(float64)
	return number, ok
}

func formatMetric(value float64, suffix string) string {
	return strconv.FormatFloat(value, 'f', -1, 64) + suffix
}

func formatBytes(value float64) string {
	units := []string{"B", "KiB", "MiB", "GiB", "TiB"}
	unit := 0
	for value >= 1024 && unit < len(units)-1 {
		value /= 1024
		unit++
	}
	return strconv.FormatFloat(value, 'f', 1, 64) + " " + units[unit]
}

func printRevisions(w io.Writer, result map[string]any) {
	revisions, _ := result["revisions"].([]any)
	output.Section(w, fmt.Sprintf("Revisions (%d)", len(revisions)))
	if len(revisions) == 0 {
		output.Field(w, "Items", "none")
	}
	for i, value := range revisions {
		revision, ok := value.(map[string]any)
		if !ok {
			continue
		}
		if i > 0 {
			fmt.Fprintln(w)
		}
		if id, ok := revision["id"].(string); ok {
			output.Field(w, "ID", output.ShortID(id))
		}
		if createdAt, ok := revision["createdAt"].(string); ok {
			output.Field(w, "Created", output.Timestamp(createdAt))
		}
		if actor, ok := revision["actor"].(map[string]any); ok {
			output.Field(w, "Actor", revisionActor(actor))
		}
		if rollout, ok := revision["rollout"].(map[string]any); ok {
			id, _ := rollout["id"].(string)
			status, _ := rollout["status"].(string)
			value := output.ShortID(id)
			if status != "" {
				value += " (" + output.Status(status) + ")"
			}
			output.Field(w, "Rollout", value)
		}
		printRevisionChanges(w, revision["comparison"])
	}
	if cursor, ok := result["nextCursor"].(string); ok && cursor != "" {
		output.Field(w, "Next", cursor)
	}
}

func printRollouts(w io.Writer, result map[string]any) {
	rollouts, _ := result["rollouts"].([]any)
	output.Section(w, fmt.Sprintf("Rollouts (%d)", len(rollouts)))
	if len(rollouts) == 0 {
		output.Field(w, "Items", "none")
	}
	for i, value := range rollouts {
		rollout, ok := value.(map[string]any)
		if !ok {
			continue
		}
		if i > 0 {
			fmt.Fprintln(w)
		}
		printRolloutFields(w, rollout)
	}
	if cursor, ok := result["nextCursor"].(string); ok && cursor != "" {
		output.Field(w, "Next", cursor)
	}
}

func printRolloutDetail(w io.Writer, result map[string]any) {
	output.Section(w, "Rollout")
	rollout, ok := result["rollout"].(map[string]any)
	if !ok {
		output.Field(w, "Status", "unavailable")
		return
	}
	printRolloutFields(w, rollout)
}

func printRolloutFields(w io.Writer, rollout map[string]any) {
	for _, field := range []struct {
		key, label string
	}{
		{"id", "ID"},
		{"status", "Status"},
		{"currentStage", "Stage"},
		{"createdAt", "Created"},
		{"completedAt", "Completed"},
	} {
		value, ok := rollout[field.key].(string)
		if !ok || value == "" {
			continue
		}
		switch field.key {
		case "id":
			value = output.ShortID(value)
		case "status", "currentStage":
			value = output.Status(value)
		case "createdAt", "completedAt":
			value = output.Timestamp(value)
		}
		output.Field(w, field.label, value)
	}

	deployments, _ := rollout["deployments"].([]any)
	output.Field(w, "Deployments", len(deployments))
	for _, value := range deployments {
		deployment, ok := value.(map[string]any)
		if !ok {
			continue
		}
		server, _ := deployment["serverName"].(string)
		phase, _ := deployment["phase"].(string)
		health, _ := deployment["healthStatus"].(string)
		state := output.Status(phase)
		if health != "" {
			if state != "" {
				state += ", "
			}
			state += output.Status(health)
		}
		fmt.Fprintf(w, "    * %s", server)
		if state != "" {
			fmt.Fprintf(w, ": %s", state)
		}
		fmt.Fprintln(w)
	}
}

func printRolloutLogs(w io.Writer, result map[string]any) {
	if result["provider"] == "disabled" {
		output.Section(w, "Rollout logs")
		output.Field(w, "Status", "disabled")
		return
	}
	logs, _ := result["logs"].([]any)
	output.Section(w, fmt.Sprintf("Rollout logs (%d)", len(logs)))
	if len(logs) == 0 {
		output.Field(w, "Lines", "none")
		return
	}
	for _, value := range logs {
		log, ok := value.(map[string]any)
		if !ok {
			continue
		}
		timestamp, _ := log["timestamp"].(string)
		stage, _ := log["stage"].(string)
		message, _ := log["message"].(string)
		if stage == "" {
			stage = "rollout"
		}
		fmt.Fprintf(w, "%s %-16s %s\n", output.Timestamp(timestamp), "["+output.Status(stage)+"]", strings.TrimRight(message, "\n"))
	}
}

func revisionActor(actor map[string]any) string {
	switch actor["type"] {
	case "user":
		if name, ok := actor["name"].(string); ok {
			return name
		}
	case "github":
		if login, ok := actor["login"].(string); ok {
			return "@" + login
		}
	case "system":
		return "system"
	}
	return "unknown"
}

func printRevisionChanges(w io.Writer, value any) {
	comparison, ok := value.(map[string]any)
	if !ok {
		output.Field(w, "Changes", "unavailable")
		return
	}
	switch comparison["kind"] {
	case "initial":
		output.Field(w, "Changes", "initial revision")
	case "unavailable":
		output.Field(w, "Changes", "unavailable")
	case "changes":
		changes, _ := comparison["changes"].([]any)
		if len(changes) == 0 {
			output.Field(w, "Changes", "none")
			return
		}
		output.Field(w, "Changes", len(changes))
		for _, value := range changes {
			change, ok := value.(map[string]any)
			if !ok {
				continue
			}
			fmt.Fprintf(w, "    * %v: %v -> %v\n", change["field"], change["from"], change["to"])
		}
	default:
		output.Field(w, "Changes", "unavailable")
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

func selectFromList[T any](
	reader *bufio.Reader,
	out io.Writer,
	title string,
	items []T,
	render func(T) string,
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
		return items[choice-1], nil
	}
}
