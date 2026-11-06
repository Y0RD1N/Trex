use anyhow::{bail, Context, Result};
use clap::{Args, Parser, Subcommand};
use serde_json::{json, Value};
use std::{
    io::{IsTerminal, Read},
    path::PathBuf,
};
use trex_agent::{profile, provider, server};

#[derive(Parser)]
#[command(
    version,
    about = "Native API coding agent; credentials are stored by the operating system"
)]
struct Cli {
    #[arg(long, global = true)]
    profile: Option<String>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Profiles {
        #[command(subcommand)]
        command: Profiles,
    },
    Models {
        #[command(subcommand)]
        command: Models,
    },
    Sessions {
        #[command(subcommand)]
        command: Sessions,
    },
    /// Run one task; failures have nonzero exit codes. JSON emits protocol events.
    Exec {
        prompt: Option<String>,
        #[arg(long, conflicts_with = "prompt")]
        file: Option<PathBuf>,
        #[command(flatten)]
        launch: Launch,
    },
    Config {
        #[command(subcommand)]
        command: Config,
    },
    Mcp {
        #[command(subcommand)]
        command: Mcp,
    },
    /// Inspect configuration and installed capabilities; --connect only fetches metadata.
    Doctor {
        #[arg(long)]
        connect: bool,
        #[arg(long)]
        json: bool,
    },
    Metrics {
        #[arg(long)]
        json: bool,
    },
    Artifacts {
        #[command(subcommand)]
        command: Artifacts,
    },
    /// Inspect or restore native file checkpoints after reviewing their differences.
    Changes {
        #[command(subcommand)]
        command: Changes,
    },
    /// Run an explicit benchmark suite against the selected provider (may incur API charges).
    Eval {
        #[arg(long)]
        suite: PathBuf,
        #[arg(long,default_value="plan",value_parser=["plan","full"])]
        mode: String,
        #[arg(long)]
        output: Option<PathBuf>,
    },
    AppServer,
    DesktopMcp {
        #[arg(long)]
        mode: String,
    },
    /// Inspect desktop availability without capturing the screen or sending input.
    DesktopDoctor {
        #[arg(long)]
        json: bool,
    },
    /// Accessibility control with Trex's built-in engine (Windows), as an MCP server.
    A11yMcp {
        #[arg(long, value_parser = ["plan", "full"])]
        mode: String,
        /// Kept so saved configurations still start: every value uses the built-in engine.
        #[arg(long, hide = true, default_value = "trex", value_parser = ["auto", "trex", "agent-desktop"])]
        engine: String,
        /// Allow real keyboard shortcuts (a11y_press); off unless enabled in Trex settings.
        #[arg(long)]
        keyboard: bool,
    },
    /// Whether the built-in accessibility engine is available, without opening applications.
    A11yDoctor {
        #[arg(long)]
        json: bool,
    },
    Chat {
        #[command(flatten)]
        launch: Launch,
    },
}

#[derive(Args)]
struct Launch {
    #[arg(long, default_value = "ask")]
    mode: String,
    #[arg(long)]
    cwd: Option<PathBuf>,
    #[arg(long)]
    conversation: Option<String>,
    #[arg(long)]
    model: Option<String>,
    #[arg(long)]
    effort: Option<String>,
    #[arg(long)]
    browser: bool,
    #[arg(long, requires = "browser")]
    browser_profile: Option<String>,
    #[arg(long)]
    desktop: bool,
    #[arg(long)]
    json: bool,
    #[arg(long)]
    show_thinking: bool,
    #[arg(long)]
    settings: Option<PathBuf>,
    #[arg(long)]
    instructions: Option<PathBuf>,
    #[arg(long)]
    attach: Vec<PathBuf>,
}
impl Launch {
    fn options(self, profile: &profile::Profile) -> Result<(trex_agent::console::Options, String)> {
        let cwd = self
            .cwd
            .unwrap_or(std::env::current_dir()?)
            .canonicalize()?;
        let settings = self
            .settings
            .map(|p| read_text(&p, 64 * 1024).and_then(|s| Ok(serde_json::from_str::<Value>(&s)?)))
            .transpose()?;
        let resolved = trex_agent::settings::overlay(
            trex_agent::settings::Settings::load(Some(&profile.name))?,
            settings.as_ref(),
        )?;
        let (attachments, images) =
            trex_agent::console::attachments(&self.attach, &cwd, &resolved.privacy)?;
        let options = trex_agent::console::Options {
            cwd,
            mode: self.mode,
            conversation: self.conversation,
            model: self.model,
            effort: self.effort,
            browser: self.browser,
            browser_profile: self.browser_profile,
            desktop: self.desktop,
            json: self.json,
            thinking: self.show_thinking,
            settings,
            images,
            instructions: self
                .instructions
                .map(|p| read_text(&p, 32 * 1024))
                .transpose()?,
            attachments_text: String::new(),
        };
        Ok((options, attachments))
    }
}
#[derive(Subcommand)]
enum Config {
    Show,
    Set {
        #[arg(long, required = true)]
        stdin_json: bool,
    },
}
#[derive(Subcommand)]
enum Mcp {
    List,
    Add {
        #[arg(long, required = true)]
        stdin_json: bool,
    },
    Remove {
        name: String,
    },
}
#[derive(Subcommand)]
enum Artifacts {
    Gc {
        #[arg(long)]
        apply: bool,
    },
}
#[derive(Subcommand)]
enum Changes {
    List {
        #[arg(long)]
        cwd: Option<PathBuf>,
    },
    Diff {
        id: String,
        #[arg(long)]
        cwd: Option<PathBuf>,
    },
    Restore {
        id: String,
        #[arg(long)]
        cwd: Option<PathBuf>,
    },
}

#[derive(Subcommand)]
enum Profiles {
    List {
        #[arg(long)]
        json: bool,
    },
    Save {
        #[arg(long, required = true)]
        stdin_json: bool,
    },
    Remove {
        name: String,
    },
}

#[derive(Subcommand)]
enum Models {
    List {
        #[arg(long)]
        json: bool,
        #[arg(long, requires = "json")]
        stdin_json: bool,
    },
}

#[derive(Subcommand)]
enum Sessions {
    List {
        #[arg(long)]
        json: bool,
    },
    Export {
        id: String,
        #[arg(long,default_value="json",value_parser=["json","markdown"])]
        format: String,
        #[arg(long)]
        output: Option<PathBuf>,
    },
    Fork {
        id: String,
    },
    /// Move a closed conversation to recoverable private trash.
    Remove {
        id: String,
    },
    Restore {
        id: String,
    },
}

fn print_json(value: &impl serde::Serialize) -> Result<()> {
    println!("{}", serde_json::to_string(value)?);
    Ok(())
}

fn main() {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("trex-agent: cannot initialize runtime: {error}");
            std::process::exit(1);
        }
    };
    let result = runtime.block_on(run());
    // Tokio stdin uses a blocking OS read, which cannot be cancelled while a
    // pipe remains open. Do not let that read hold process shutdown forever.
    runtime.shutdown_timeout(std::time::Duration::from_millis(250));
    if let Err(error) = result {
        let exit_code = error
            .downcast_ref::<trex_agent::console::RunError>()
            .map(|e| e.code)
            .unwrap_or(1);
        if let Some(code) = error.downcast_ref::<provider::CatalogError>() {
            // The strict management protocol never exposes raw upstream,
            // input, URL, credential-store, or transport error text.
            let _ = print_json(&json!({"error":{"code":code}}));
        } else {
            eprintln!("trex-agent: {error:#}");
        }
        std::process::exit(exit_code);
    }
}

async fn run() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Profiles { command } => match command {
            Profiles::List { json: as_json } => {
                let profiles = profile::list()?;
                if as_json {
                    print_json(&profiles)?;
                } else {
                    for p in profiles {
                        println!(
                            "{}\t{}\t{}\t{}",
                            p["name"].as_str().unwrap_or(""),
                            p["provider"].as_str().unwrap_or(""),
                            p["model"].as_str().unwrap_or(""),
                            if p["hasApiKey"] == true {
                                "key stored"
                            } else {
                                "no key"
                            }
                        );
                    }
                }
            }
            Profiles::Save { .. } => {
                let mut bytes = Vec::new();
                std::io::stdin()
                    .take(1024 * 1024 + 1)
                    .read_to_end(&mut bytes)?;
                if bytes.len() > 1024 * 1024 {
                    bail!("profile input exceeds 1 MiB");
                }
                let input: Value =
                    serde_json::from_slice(&bytes).context("expected one JSON profile on stdin")?;
                print_json(&profile::save(input)?)?;
            }
            Profiles::Remove { name } => profile::remove(&name)?,
        },
        Command::Models {
            command:
                Models::List {
                    json: as_json,
                    stdin_json,
                },
        } => {
            if stdin_json {
                if cli.profile.is_some() {
                    return Err(provider::CatalogError::InvalidRequest.into());
                }
                let mut bytes = Vec::new();
                std::io::stdin()
                    .take(1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| provider::CatalogError::InvalidRequest)?;
                if bytes.len() > 1024 * 1024 {
                    return Err(provider::CatalogError::InvalidRequest.into());
                }
                let input: Value = serde_json::from_slice(&bytes)
                    .map_err(|_| provider::CatalogError::InvalidRequest)?;
                let models = provider::discover_models(input).await?;
                print_json(&json!({"models":models,"source":"remote"}))?;
                return Ok(());
            }
            let profile = selected(cli.profile)?;
            let models = provider::models(&profile).await?;
            if as_json {
                print_json(&json!({"models":models}))?;
            } else {
                for model in models {
                    println!(
                        "{}\t{}",
                        model["id"].as_str().unwrap_or(""),
                        model["name"].as_str().unwrap_or("")
                    );
                }
            }
        }
        Command::Sessions {
            command: Sessions::List { json: as_json },
        } => {
            let sessions = server::list_sessions(cli.profile.as_deref())?;
            if as_json {
                print_json(&sessions)?;
            } else {
                for session in sessions {
                    println!(
                        "{}\t{}\t{}",
                        session["id"].as_str().unwrap_or(""),
                        session["title"].as_str().unwrap_or(""),
                        session["cwd"].as_str().unwrap_or("")
                    );
                }
            }
        }
        Command::Sessions {
            command: Sessions::Export { id, format, output },
        } => {
            let text = server::export_session(&id, format == "markdown")?;
            if let Some(path) = output {
                use std::io::Write;
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let mut file = options.open(path)?;
                file.write_all(text.as_bytes())?;
                file.sync_all()?;
            } else {
                println!("{text}");
            }
        }
        Command::Sessions {
            command: Sessions::Fork { id },
        } => print_json(&server::fork_session(&id)?)?,
        Command::Sessions {
            command: Sessions::Remove { id },
        } => print_json(&server::remove_session(&id)?)?,
        Command::Sessions {
            command: Sessions::Restore { id },
        } => print_json(&server::restore_session(&id)?)?,
        Command::Config {
            command: Config::Show,
        } => print_json(&match cli.profile {
            Some(p) => serde_json::to_value(trex_agent::settings::Settings::load(Some(&p))?)?,
            None => trex_agent::settings::show()?,
        })?,
        Command::Config {
            command: Config::Set { .. },
        } => {
            let value = read_json()?;
            print_json(&trex_agent::settings::save(value)?)?;
        }
        Command::Mcp { command } => {
            let mut document = trex_agent::settings::show()?;
            match command {
                Mcp::List => print_json(&document["defaults"]["mcpServers"])?,
                Mcp::Add { .. } => {
                    let server: trex_agent::settings::McpServer =
                        serde_json::from_value(read_json()?)?;
                    let servers = document["defaults"]["mcpServers"]
                        .as_array_mut()
                        .context("invalid MCP configuration")?;
                    servers.retain(|s| s["name"].as_str() != Some(&server.name));
                    servers.push(serde_json::to_value(server)?);
                    trex_agent::settings::save(document)?;
                    print_json(&json!({"saved":true}))?;
                }
                Mcp::Remove { name } => {
                    document["defaults"]["mcpServers"]
                        .as_array_mut()
                        .context("invalid MCP configuration")?
                        .retain(|s| s["name"].as_str() != Some(&name));
                    trex_agent::settings::save(document)?;
                    print_json(&json!({"removed":true}))?;
                }
            }
        }
        Command::Metrics { json: _ } => print_json(&trex_agent::diagnostics::report()?)?,
        Command::Artifacts {
            command: Artifacts::Gc { apply },
        } => print_json(&server::artifact_gc(apply)?)?,
        Command::Changes { command } => {
            let settings = trex_agent::settings::Settings::load(cli.profile.as_deref())?;
            let result = match command {
                Changes::List { cwd } => {
                    trex_agent::changes::list(&cwd.unwrap_or(std::env::current_dir()?))?
                }
                Changes::Diff { id, cwd } => {
                    trex_agent::changes::diff(&cwd.unwrap_or(std::env::current_dir()?), &id)?
                }
                Changes::Restore { id, cwd } => trex_agent::changes::undo(
                    &cwd.unwrap_or(std::env::current_dir()?),
                    &id,
                    &settings.privacy,
                )?,
            };
            print_json(&result)?;
        }
        Command::Eval {
            suite,
            mode,
            output,
        } => {
            let result = trex_agent::evaluation::run(
                selected(cli.profile)?,
                &read_text(&suite, 4 * 1024 * 1024)?,
                &mode,
            )
            .await?;
            if let Some(path) = output {
                use std::io::Write;
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let mut file = options.open(path)?;
                file.write_all(&serde_json::to_vec_pretty(&result)?)?;
                file.sync_all()?;
            }
            print_json(&result)?;
            if result["passed"] != true {
                bail!("one or more evaluation cases failed");
            }
        }
        Command::Doctor { connect, json: _ } => {
            let settings = trex_agent::settings::Settings::load(cli.profile.as_deref())?;
            let mut result = json!({"version":env!("CARGO_PKG_VERSION"),"configurationValid":true,"desktop":trex_agent::desktop::doctor().await?,"mcpServers":settings.mcp_servers.iter().map(|s|json!({"name":s.name,"enabled":s.enabled,"executableExists":s.command.is_file()})).collect::<Vec<_>>(),"completionCalls":0});
            if let Some(name) = cli.profile {
                let p = profile::load(&name)?;
                result["profile"] = json!({"name":p.name,"provider":p.provider,"hasApiKey":profile::api_key(&p)?.is_some()});
                if connect {
                    match provider::models(&p).await {
                        Ok(models) => result["models"] = json!(models),
                        Err(e) => {
                            result["connectionError"] = json!(e.to_string());
                            print_json(&result)?;
                            return Err(e);
                        }
                    }
                }
            }
            print_json(&result)?;
        }
        Command::AppServer => server::run(selected(cli.profile)?).await?,
        Command::DesktopMcp { mode } => trex_agent::desktop_mcp::serve(&mode).await?,
        Command::DesktopDoctor { json: _ } => print_json(&trex_agent::desktop::doctor().await?)?,
        Command::A11yMcp { mode, engine: _, keyboard } => tokio::task::spawn_blocking(move || trex_agent::a11y_mcp::serve(&mode, keyboard)).await??,
        Command::A11yDoctor { json: _ } => print_json(&tokio::task::spawn_blocking(trex_agent::a11y_mcp::doctor).await?)?,
        Command::Chat { launch } => {
            let profile = selected(cli.profile)?;
            let (mut options, attachments) = launch.options(&profile)?;
            options.attachments_text = attachments;
            trex_agent::console::run(profile, options, None).await?;
        }
        Command::Exec {
            prompt,
            file,
            launch,
        } => {
            let profile = selected(cli.profile)?;
            let (options, attachments) = launch.options(&profile)?;
            let mut prompt = if let Some(path) = file {
                read_text(&path, 8 * 1024 * 1024)?
            } else if let Some(prompt) = prompt {
                prompt
            } else {
                if std::io::stdin().is_terminal() {
                    bail!("supply a prompt, --file, or piped stdin");
                }
                let mut s = String::new();
                std::io::stdin()
                    .take(8 * 1024 * 1024 + 1)
                    .read_to_string(&mut s)?;
                if s.len() > 8 * 1024 * 1024 {
                    bail!("prompt exceeds 8 MiB");
                }
                s
            };
            prompt.push_str(&attachments);
            trex_agent::console::run(profile, options, Some(prompt)).await?;
        }
    }
    Ok(())
}

fn selected(name: Option<String>) -> Result<profile::Profile> {
    profile::load(&name.context("select a saved profile with --profile NAME")?)
}
fn read_text(path: &std::path::Path, max: usize) -> Result<String> {
    let file = std::fs::File::open(path)?;
    if file.metadata()?.len() > max as u64 {
        bail!("input file exceeds size limit");
    }
    let mut text = String::new();
    file.take(max as u64 + 1).read_to_string(&mut text)?;
    if text.len() > max {
        bail!("input file exceeds size limit");
    }
    Ok(text)
}
fn read_json() -> Result<Value> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 1024 * 1024 {
        bail!("input exceeds 1 MiB");
    }
    serde_json::from_slice(&bytes).context("expected one JSON object on stdin")
}
