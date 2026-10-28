use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use serde_json::{json, Value};
use std::io::Read;
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
    AppServer,
    DesktopMcp {
        #[arg(long)]
        mode: String,
    },
    Chat {
        #[arg(long, default_value = "ask")]
        mode: String,
        #[arg(long)]
        cwd: Option<std::path::PathBuf>,
        #[arg(long)]
        conversation: Option<String>,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        effort: Option<String>,
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
        if let Some(code) = error.downcast_ref::<provider::CatalogError>() {
            // The strict management protocol never exposes raw upstream,
            // input, URL, credential-store, or transport error text.
            let _ = print_json(&json!({"error":{"code":code}}));
        } else {
            eprintln!("trex-agent: {error:#}");
        }
        std::process::exit(1);
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
        Command::AppServer => server::run(selected(cli.profile)?).await?,
        Command::DesktopMcp { mode } => trex_agent::desktop_mcp::serve(&mode).await?,
        Command::Chat {
            mode,
            cwd,
            conversation,
            model,
            effort,
        } => {
            server::chat(
                selected(cli.profile)?,
                cwd.unwrap_or(std::env::current_dir()?),
                &mode,
                conversation,
                model,
                effort,
            )
            .await?;
        }
    }
    Ok(())
}

fn selected(name: Option<String>) -> Result<profile::Profile> {
    profile::load(&name.context("select a saved profile with --profile NAME")?)
}
