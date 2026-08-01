//! Tokscale local dashboard — a standalone full-dashboard Tauri app.
//!
//! Spawned by the desktop widget's "Open frontend app" menu entry. Renders a
//! large window with all-time stats, a full-year contribution heatmap, monthly
//! cost trend, and per-supplier / per-model breakdowns — all from local
//! tokscale-core data, no external API.

use tokscale_core::{
    generate_local_graph_report, get_hourly_report, get_model_report, get_monthly_report,
    scanner::ScannerSettings, GraphResult, GroupBy, HourlyReport, ModelReport, MonthlyReport,
    ReportOptions,
};
use tokscale_usage::UsageOutput;

fn base_options(group_by: GroupBy, since: Option<String>, until: Option<String>) -> ReportOptions {
    ReportOptions {
        home_dir: None,
        use_env_roots: true,
        clients: None,
        since,
        until,
        year: None,
        group_by,
        scanner_settings: ScannerSettings::default(),
    }
}

#[tauri::command]
async fn get_overview_graph() -> Result<GraphResult, String> {
    generate_local_graph_report(base_options(GroupBy::Model, None, None)).await
}

#[tauri::command]
async fn get_models_report(
    group_by: Option<String>,
    since: Option<String>,
    until: Option<String>,
) -> Result<ModelReport, String> {
    let group_by = group_by
        .unwrap_or_else(|| "client,model".to_string())
        .parse::<GroupBy>()
        .unwrap_or(GroupBy::ClientModel);
    match tokio::time::timeout(
        std::time::Duration::from_secs(30),
        get_model_report(base_options(group_by, since, until)),
    )
    .await
    {
        Ok(r) => r,
        Err(_) => Err("models report timed out".into()),
    }
}

#[tauri::command]
async fn get_monthly_view() -> Result<MonthlyReport, String> {
    get_monthly_report(base_options(GroupBy::Model, None, None)).await
}

#[tauri::command]
async fn get_hourly_view() -> Result<HourlyReport, String> {
    get_hourly_report(base_options(GroupBy::Model, None, None)).await
}

#[tauri::command]
async fn get_subscription_usage() -> Result<Vec<UsageOutput>, String> {
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        tokio::task::spawn_blocking(|| {
            tokscale_usage::fetch_all_report_with_intent(
                tokscale_usage::UsageFetchIntent::CliReadOnly,
            )
        }),
    )
    .await;
    match result {
        Ok(Ok(report)) => Ok(report.outputs),
        Ok(Err(e)) => Err(format!("usage worker join failed: {e}")),
        Err(_) => Ok(tokscale_usage::load_cache().unwrap_or_default()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_overview_graph,
            get_models_report,
            get_monthly_view,
            get_hourly_view,
            get_subscription_usage,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tokscale frontend");
}
