//! Warp/Oz CLI surface.
//!
//! The credentials/cache/GraphQL data layer lives in
//! `tokscale_usage::warp_cache` (shared with the desktop widget). This module
//! keeps only the interactive commands: login (reads the secret from the
//! terminal), logout, status (pretty-prints), and sync (drives the async fetch
//! and pretty-prints). It re-exports the data-layer helpers `load_usage_cache`,
//! `has_credentials`, `get_warp_cache_dir`, and `WarpAggregateUsage` so
//! existing `crate::warp::*` call sites in `main.rs` keep compiling.

use anyhow::{Context, Result};
use colored::Colorize;
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::Path;

pub use tokscale_usage::warp_cache::{
    get_warp_cache_dir, has_credentials, load_usage_cache, WarpAggregateUsage,
};
use tokscale_usage::warp_cache;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WarpStatus {
    cache_dir: String,
    credentials_path: String,
    usage_path: String,
    has_credentials: bool,
    has_cache: bool,
    requests_used: Option<i64>,
    request_limit: Option<i64>,
    spend_cents: Option<i64>,
    workspace_count: usize,
    diagnostics: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncWarpResult {
    synced: bool,
    requests_used: Option<i64>,
    spend_cents: Option<i64>,
    workspace_count: usize,
    error: Option<String>,
}

pub fn has_usage_cache_in_home(home_dir: &Path) -> bool {
    home_dir
        .join(".config/tokscale/warp-cache/usage.json")
        .exists()
}

pub fn run_warp_login(token: Option<String>, cookie: bool) -> Result<()> {
    println!("\n  {}\n", "Warp/Oz - Login".cyan());
    let auth_value = match token {
        Some(token) => token,
        None => {
            print!("  Enter Warp bearer token or Cookie header value: ");
            std::io::stdout().flush()?;
            rpassword::read_password().context("Failed to read Warp credential")?
        }
    };
    let auth_value = auth_value.trim().to_string();
    if auth_value.is_empty() {
        anyhow::bail!("Warp credential must not be empty");
    }

    warp_cache::save_credentials(&warp_cache::WarpCredentials {
        auth_value,
        auth_kind: if cookie {
            warp_cache::WarpAuthKind::Cookie
        } else {
            warp_cache::WarpAuthKind::Bearer
        },
        created_at: chrono::Utc::now().to_rfc3339(),
    })?;

    println!("{}", "  Warp credentials saved.".green());
    println!(
        "{}",
        "  Run `tokscale warp sync` to cache aggregate requests and spend.".bright_black()
    );
    Ok(())
}

pub fn run_warp_logout(purge_cache: bool) -> Result<()> {
    let creds = get_warp_cache_dir().join("credentials.json");
    if creds.exists() {
        fs::remove_file(creds)?;
    }
    if purge_cache {
        let usage = get_warp_cache_dir().join("usage.json");
        if usage.exists() {
            fs::remove_file(usage)?;
        }
    }
    println!("{}", "  Warp credentials removed.".green());
    Ok(())
}

pub fn run_warp_status(json: bool) -> Result<()> {
    let status = build_status();
    if json {
        println!("{}", serde_json::to_string_pretty(&status)?);
        return Ok(());
    }

    println!("\n  {}", "Warp/Oz aggregate usage".cyan());
    println!(
        "  {} {}",
        "Credentials:".bright_black(),
        if status.has_credentials {
            "found".green()
        } else {
            "missing".yellow()
        }
    );
    println!(
        "  {} {}",
        "Cache:".bright_black(),
        if status.has_cache {
            status.usage_path.green()
        } else {
            status.usage_path.yellow()
        }
    );
    if let Some(requests) = status.requests_used {
        println!("  {} {}", "Requests:".bright_black(), requests);
    }
    if let Some(limit) = status.request_limit {
        println!("  {} {}", "Request limit:".bright_black(), limit);
    }
    if let Some(cents) = status.spend_cents {
        println!(
            "  {} ${:.2}",
            "Current spend:".bright_black(),
            cents as f64 / 100.0
        );
    }
    for diagnostic in status.diagnostics {
        println!("{}", format!("  Warning: {diagnostic}").yellow());
    }
    println!();
    Ok(())
}

pub fn run_warp_sync(json: bool) -> Result<()> {
    let rt = tokio::runtime::Runtime::new()?;
    let outcome = rt.block_on(warp_cache::sync_cache());
    let result = SyncWarpResult {
        synced: outcome.synced,
        requests_used: outcome.requests_used,
        spend_cents: outcome.spend_cents,
        workspace_count: outcome.workspace_count,
        error: outcome.error,
    };
    if json {
        println!("{}", serde_json::to_string_pretty(&result)?);
        return Ok(());
    }

    if result.synced {
        println!(
            "{}",
            format!(
                "  Warp: synced aggregate usage (requests={}, spend=${:.2}, workspaces={})",
                result.requests_used.unwrap_or(0),
                result.spend_cents.unwrap_or(0) as f64 / 100.0,
                result.workspace_count
            )
            .green()
        );
    } else if let Some(error) = result.error {
        eprintln!("{}", format!("  Warp sync failed: {error}").yellow());
    }
    Ok(())
}

fn build_status() -> WarpStatus {
    let cache = load_usage_cache();
    let has_creds = has_credentials();
    let has_cache = cache.is_some();
    let cache_dir = get_warp_cache_dir();
    let credentials_path = cache_dir.join("credentials.json");
    let usage_path = cache_dir.join("usage.json");
    let mut diagnostics = Vec::new();
    if !has_creds {
        diagnostics.push("missing credentials; run `tokscale warp login`".to_string());
    }
    if !has_cache {
        diagnostics.push("missing aggregate usage cache; run `tokscale warp sync`".to_string());
    }

    let usage = cache.as_ref().map(|cache| &cache.usage);
    WarpStatus {
        cache_dir: cache_dir.to_string_lossy().to_string(),
        credentials_path: credentials_path.to_string_lossy().to_string(),
        usage_path: usage_path.to_string_lossy().to_string(),
        has_credentials: has_creds,
        has_cache,
        requests_used: usage.and_then(|usage| usage.requests_used),
        request_limit: usage.and_then(|usage| usage.request_limit),
        spend_cents: usage.and_then(|usage| usage.spend_cents),
        workspace_count: cache.map(|cache| cache.workspaces.len()).unwrap_or(0),
        diagnostics,
    }
}
