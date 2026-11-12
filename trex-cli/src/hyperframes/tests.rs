use super::*;

/// A project with a fake `hyperframes` CLI at node_modules/.bin (found first, like a project-local install).
#[cfg(unix)]
fn project(script: &str) -> tempfile::TempDir {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("node_modules/.bin");
    std::fs::create_dir_all(&bin).unwrap();
    let cli = bin.join("hyperframes");
    std::fs::write(&cli, format!("#!/bin/sh\n{script}\n")).unwrap();
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    // Fixtures the fake copies as "snapshots": a wide frame, and a wide contact sheet.
    image::RgbImage::from_pixel(2000, 1000, image::Rgb([200, 30, 30])).save(dir.path().join("frame.png")).unwrap();
    image::RgbImage::from_pixel(2400, 400, image::Rgb([30, 30, 200])).save(dir.path().join("sheet.jpg")).unwrap();
    dir
}
async fn call(dir: &Path, mode: &str, name: &str, input: Value) -> Result<Value> {
    HyperframesProvider.execute(dir, mode, name, &input, "op", CancellationToken::new()).await
}
fn texts(result: &Value) -> String {
    result["content"].as_array().unwrap().iter().filter(|c| c["type"] == "text").map(|c| c["text"].as_str().unwrap()).collect::<Vec<_>>().join("\n")
}
fn images(result: &Value) -> Vec<&Value> {
    result["content"].as_array().unwrap().iter().filter(|c| c["type"] == "image").collect()
}
const COMMON: &str = r##"
case "$1" in
  info) echo '{"name":"proj","resolution":"landscape","width":1920,"height":1080,"duration":10,"elements":2,"tracks":1,"_meta":{"version":"0.9.10","latestVersion":"0.9.32","updateAvailable":true}}';;
  compositions) echo '{"compositions":[{"id":"main","duration":10,"width":1920,"height":1080,"elementCount":1}]}';;
  docs) if [ "$2" = "env" ]; then env | grep -E '^(HYPERFRAMES_|NO_COLOR)' | sort; else echo "Available topics: compositions gsap"; fi;;
  doctor) echo '{"ok":false,"checks":[{"ok":false,"name":"Version","detail":"0.9.10 → 0.9.32 available","hint":"Run: hyperframes upgrade"},{"ok":true,"name":"Node.js","detail":"v24"},{"ok":false,"name":"FFmpeg","detail":"Not found","hint":"apt install ffmpeg"},{"ok":false,"name":"TTS (Kokoro)","detail":"Not installed (optional)","hint":"pip install kokoro-onnx"}],"_meta":{"version":"0.9.10","latestVersion":"0.9.32","updateAvailable":true}}';;
  lint) echo '{"ok":true,"errorCount":0,"warningCount":0,"infoCount":0,"findings":[]}';;
  check) echo '[hyperframes] progress on stderr' >&2
    echo '{"ok":false,"browserSkipped":false,"lint":{"ok":true,"errorCount":0,"warningCount":0,"findings":[]},"layout":{"ok":false,"errorCount":1,"warningCount":1,"findings":[{"code":"warn_thing","severity":"warning","message":"minor"},{"code":"overlap","severity":"error","time":2.5,"selector":"#title","message":"Title overlaps subtitle","fixHint":"Move the subtitle down"}]},"saved":{"report":"/x/report.json"}}'; exit 1;;
esac
"##;

#[test]
fn planning_has_only_the_read_tools_and_the_write_tools_are_flagged() {
    let names = |mode: &str| HyperframesProvider.definitions(mode).iter().map(|t| t["function"]["name"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert_eq!(names("plan"), vec!["hyperframes_project", "hyperframes_docs", "hyperframes_doctor", "hyperframes_check"]);
    for write in ["hyperframes_snapshot", "hyperframes_render", "hyperframes_preview", "hyperframes_init"] {
        assert!(names("full").contains(&write.to_owned()));
        assert!(HyperframesProvider.is_mutating(write, &json!({})), "{write}");
    }
    for read in READ {
        assert!(!HyperframesProvider.is_mutating(read, &json!({})), "{read}");
    }
    let plan = HyperframesProvider.guidance("plan").unwrap();
    for write in ["hyperframes_render", "hyperframes_snapshot", "hyperframes_init", "hyperframes_preview"] {
        assert!(!plan.contains(write), "plan guidance names {write}");
    }
    assert!(HyperframesProvider.guidance("full").unwrap().contains("LOOK at the frames"));
}

#[cfg(unix)]
#[tokio::test]
async fn planning_refuses_to_execute_a_write() {
    let dir = project(COMMON);
    let error = call(dir.path(), "plan", "hyperframes_render", json!({"output":"a.mp4"})).await.unwrap_err();
    assert!(error.to_string().contains("planning mode"));
}

#[cfg(unix)]
#[tokio::test]
async fn project_summarises_info_and_compositions_and_mentions_an_update() {
    let dir = project(COMMON);
    let result = call(dir.path(), "plan", "hyperframes_project", json!({})).await.unwrap();
    let report = texts(&result);
    assert!(report.contains("Project proj: 1920x1080") && report.contains("composition main (10 s") && report.contains("0.9.32 is available"), "{report}");
    assert_eq!(result["structuredContent"]["compositions"][0]["id"], "main");
}

#[cfg(unix)]
#[tokio::test]
async fn the_cli_runs_without_telemetry_updates_installs_or_colour() {
    let dir = project(COMMON);
    let report = texts(&call(dir.path(), "plan", "hyperframes_docs", json!({"topic":"env"})).await.unwrap());
    for expected in ["HYPERFRAMES_AGENT=1", "HYPERFRAMES_NO_AUTO_INSTALL=1", "HYPERFRAMES_NO_TELEMETRY=1", "HYPERFRAMES_NO_UPDATE_CHECK=1", "HYPERFRAMES_SKIP_SKILLS=1", "NO_COLOR=1"] {
        assert!(report.contains(expected), "{expected} missing in {report}");
    }
    assert!(texts(&call(dir.path(), "plan", "hyperframes_docs", json!({})).await.unwrap()).contains("compositions"));
    for bad in [json!({"topic":"../etc"}), json!({"topic":"-rf"}), json!({"topic":"UPPER"}), json!({"extra":1})] {
        assert!(call(dir.path(), "plan", "hyperframes_docs", bad.clone()).await.is_err(), "{bad}");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn doctor_separates_what_blocks_work_from_optional_extras() {
    let dir = project(COMMON);
    let result = call(dir.path(), "plan", "hyperframes_doctor", json!({})).await.unwrap();
    let report = texts(&result);
    assert!(report.contains("1 problem(s)") && !report.contains("Version:") && report.contains("FFmpeg: Not found") && report.contains("Optional, not installed: TTS (Kokoro)"), "{report}");
    assert_eq!(result["structuredContent"]["problems"].as_array().unwrap().len(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn a_failed_check_is_an_answer_with_the_findings_that_matter_first() {
    let dir = project(COMMON);
    let result = call(dir.path(), "plan", "hyperframes_check", json!({"samples": 3})).await.unwrap();
    assert_eq!(result["isError"], false, "findings are not a tool failure");
    let report = texts(&result);
    assert!(report.starts_with("check FAILED: 1 error(s), 1 warning(s)."), "{report}");
    let error = report.find("[error] layout/overlap at 2.5s (#title)").expect("error finding listed");
    assert!(error < report.find("[warning]").unwrap(), "errors before warnings");
    assert!(report.contains("Fix: Move the subtitle down") && report.contains("Full report: /x/report.json"));
    assert_eq!(result["structuredContent"]["sections"]["layout"], json!({"errors":1,"warnings":1}));
    let lint = call(dir.path(), "plan", "hyperframes_check", json!({"scope":"lint"})).await.unwrap();
    assert!(texts(&lint).starts_with("lint PASSED"));
    assert!(call(dir.path(), "plan", "hyperframes_check", json!({"scope":"lint","samples":2})).await.is_err());
    for bad in [json!({"range":[3,1]}), json!({"samples":0}), json!({"scope":"deep"})] {
        assert!(call(dir.path(), "plan", "hyperframes_check", bad.clone()).await.is_err(), "{bad}");
    }
}

const SNAPSHOT: &str = r#"
if [ "$1" = "snapshot" ]; then
  out="$PWD/.hyperframes/artifacts/snapshots/run1"; mkdir -p "$out"
  cp "$PWD/frame.png" "$out/frame-00-at-0s.png"; cp "$PWD/frame.png" "$out/frame-01-at-5s.png"; cp "$PWD/frame.png" "$out/frame-02-at-9s.png"
  cp "$PWD/sheet.jpg" "$out/contact-sheet.jpg"
  echo "{\"ok\":true,\"outputDir\":\"$out\",\"frames\":[{\"path\":\"$out/frame-00-at-0s.png\",\"time\":0},{\"path\":\"$out/frame-01-at-5s.png\",\"time\":5},{\"path\":\"$out/frame-02-at-9s.png\",\"time\":9}],\"contactSheets\":[\"$out/contact-sheet.jpg\"]}"
  echo "ARGS: $*" >&2
fi
"#;

#[cfg(unix)]
#[tokio::test]
async fn snapshots_come_back_as_images_the_model_can_look_at() {
    let dir = project(SNAPSHOT);
    // Five frames: one sheet by default, shrunk to the image limit.
    let sheet = call(dir.path(), "full", "hyperframes_snapshot", json!({"frames": 5})).await.unwrap();
    let pictures = images(&sheet);
    assert_eq!(pictures.len(), 1);
    assert_eq!(pictures[0]["mimeType"], "image/png");
    let decoded = image::load_from_memory(&STANDARD.decode(pictures[0]["data"].as_str().unwrap()).unwrap()).unwrap();
    assert_eq!(decoded.width(), 1568, "a 2400 px sheet is shrunk to the long-edge limit");
    assert!(texts(&sheet).contains("Look at it before saying how the video looks"));
    assert_eq!(sheet["structuredContent"]["mode"], "sheet");
    // Up to three frames: separate images, each shrunk to maxEdge.
    let frames = call(dir.path(), "full", "hyperframes_snapshot", json!({"at": [0, 5], "maxEdge": 800})).await.unwrap();
    let pictures = images(&frames);
    assert_eq!(pictures.len(), 3, "the fake always writes three frames");
    let decoded = image::load_from_memory(&STANDARD.decode(pictures[0]["data"].as_str().unwrap()).unwrap()).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (800, 400));
    assert_eq!(frames["structuredContent"]["frames"][1]["path"].as_str().unwrap().split('/').next(), Some(".hyperframes"));
    // Exact moments, ranges and zoom reach the CLI as flags; anything odd never does.
    for bad in [json!({"at": []}), json!({"at": [-1]}), json!({"frames": 40}), json!({"range": [5, 2]}), json!({"zoom": "$(rm -rf /)"}), json!({"composition": "-x"}), json!({"images": "gif"})] {
        assert!(call(dir.path(), "full", "hyperframes_snapshot", bad.clone()).await.is_err(), "{bad}");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn files_outside_the_artifacts_folder_are_never_read_back() {
    let dir = project(r#"if [ "$1" = "snapshot" ]; then echo "{\"ok\":true,\"frames\":[{\"path\":\"$PWD/frame.png\",\"time\":0}],\"contactSheets\":[]}"; fi"#);
    let error = call(dir.path(), "full", "hyperframes_snapshot", json!({})).await.unwrap_err();
    assert!(error.to_string().contains("no frames"), "{error}");
}

const RENDER: &str = r#"
if [ "$1" = "render" ]; then
  while [ $# -gt 0 ]; do [ "$1" = "--output" ] && out="$2"; shift; done
  printf 'fake video bytes' > "$out"; echo "◇ $out"
fi
"#;

#[cfg(unix)]
#[tokio::test]
async fn render_writes_only_inside_the_project_and_reports_the_file() {
    let dir = project(RENDER);
    let result = call(dir.path(), "full", "hyperframes_render", json!({"output":"renders/draft.mp4","quality":"draft","fps":"30000/1001"})).await.unwrap();
    assert_eq!(result["isError"], false);
    assert!(texts(&result).starts_with("Rendered renders/draft.mp4 — 0.0 KB") || texts(&result).contains("Rendered renders/draft.mp4"), "{}", texts(&result));
    assert!(dir.path().join("renders/draft.mp4").is_file());
    std::os::unix::fs::symlink("/tmp", dir.path().join("link")).unwrap();
    for bad in [json!({"output":"../escape.mp4"}), json!({"output":"/tmp/abs.mp4"}), json!({"output":"link/x.mp4"}), json!({"output":"."}), json!({}), json!({"output":"a.mp4","fps":"30/x"}), json!({"output":"a.mp4","quality":"best"}), json!({"output":"a.mp4","format":"avi"})] {
        assert!(call(dir.path(), "full", "hyperframes_render", bad.clone()).await.is_err(), "{bad}");
    }
}

#[test]
fn a_zoom_region_must_capture_something() {
    // Found in a real run: "120,880,0,0" was accepted and the CLI answered with a blank picture.
    for good in ["120,880,600,200", "0, 0, 1920, 1080", "10.5,20,30.5,40", "#title", ".card > h2", "[data-x=\"1\"]", "div,span"] {
        assert!(zoom_region(good).is_ok(), "{good}");
    }
    for bad in ["120,880,0,0", "0,0,0,10", "10,10,10,0", "1,2,3", "1,2,3,4,5", "1,,3,4", "5", "1.2.3,4,5,6"] {
        assert!(zoom_region(bad).is_err(), "{bad}");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_bad_zoom_region_never_reaches_the_cli() {
    let dir = project(SNAPSHOT);
    let error = call(dir.path(), "full", "hyperframes_snapshot", json!({"at": [1], "zoom": "120,880,0,0"})).await.unwrap_err();
    assert!(error.to_string().contains("positive width and height"), "{error}");
    assert!(call(dir.path(), "full", "hyperframes_snapshot", json!({"at": [1], "zoom": "120,880,600,200"})).await.is_ok());
}

#[cfg(unix)]
#[tokio::test]
async fn a_poster_is_kept_next_to_the_video_and_its_path_is_reported() {
    use std::os::unix::fs::PermissionsExt;
    let dir = project(RENDER);
    // A stand-in for ffmpeg that "extracts" the fixture frame, so the test needs no real video.
    let ffmpeg = dir.path().join("fake-ffmpeg");
    std::fs::write(&ffmpeg, format!("#!/bin/sh\ncat '{}'\n", dir.path().join("frame.png").display())).unwrap();
    std::fs::set_permissions(&ffmpeg, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::env::set_var("HYPERFRAMES_FFMPEG_PATH", &ffmpeg);
    let result = call(dir.path(), "full", "hyperframes_render", json!({"output": "renders/final.mp4", "poster": true})).await.unwrap();
    std::env::remove_var("HYPERFRAMES_FFMPEG_PATH");
    assert_eq!(result["isError"], false, "{}", texts(&result));
    assert_eq!(images(&result).len(), 1, "the poster is still shown");
    assert!(texts(&result).contains("saved as renders/final.poster.png"), "{}", texts(&result));
    assert_eq!(result["structuredContent"]["poster"], "renders/final.poster.png");
    let saved = image::open(dir.path().join("renders/final.poster.png")).unwrap();
    assert_eq!((saved.width(), saved.height()), (2000, 1000), "the file keeps the full frame; only the copy shown is shrunk");
    // Without poster=true nothing extra is written.
    let plain = call(dir.path(), "full", "hyperframes_render", json!({"output": "renders/other.mp4"})).await.unwrap();
    assert_eq!(plain["structuredContent"]["poster"], Value::Null);
    assert!(!dir.path().join("renders/other.poster.png").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn a_failed_render_says_the_output_may_be_partial() {
    let dir = project(r#"if [ "$1" = "render" ]; then echo "boom: chrome crashed" >&2; exit 1; fi"#);
    let result = call(dir.path(), "full", "hyperframes_render", json!({"output":"x.mp4"})).await.unwrap();
    assert_eq!(result["isError"], true);
    assert_eq!(result["executionMayHaveChangedFiles"], true);
    assert!(texts(&result).contains("boom: chrome crashed"));
}

#[cfg(unix)]
#[tokio::test]
async fn an_interrupted_write_is_uncertain_and_an_interrupted_read_is_not() {
    let dir = project("sleep 30");
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        trigger.cancel();
    });
    let write = HyperframesProvider.execute(dir.path(), "full", "hyperframes_render", &json!({"output":"x.mp4"}), "o", cancel).await.unwrap_err();
    assert!(write.downcast_ref::<HyperframesUncertain>().is_some(), "{write}");
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        trigger.cancel();
    });
    let read = HyperframesProvider.execute(dir.path(), "plan", "hyperframes_doctor", &json!({}), "o", cancel).await.unwrap_err();
    assert!(read.downcast_ref::<HyperframesUncertain>().is_none() && read.to_string().contains("interrupted"), "{read}");
}

#[cfg(unix)]
#[tokio::test]
async fn preview_starts_reports_and_stops_from_the_cli_json() {
    let dir = project(r#"if [ "$1" = "preview" ]; then
  case "$*" in
    *--stop*) echo '{"ok":true,"result":{"state":"stopped"}}';;
    *--status*) echo '{"ok":true,"result":{"state":"not-running"}}';;
    *--background*--no-open*) echo '{"ok":true,"result":{"state":"started","projectName":"proj","studioUrl":"http://127.0.0.1:3002/#project/proj","port":3002,"pid":42}}';;
    *) echo '{"ok":false}'; exit 1;;
  esac
fi"#);
    let started = call(dir.path(), "full", "hyperframes_preview", json!({})).await.unwrap();
    assert!(texts(&started).contains("http://127.0.0.1:3002/#project/proj"));
    assert_eq!(started["structuredContent"]["port"], 3002);
    assert!(texts(&call(dir.path(), "full", "hyperframes_preview", json!({"action":"status"})).await.unwrap()).contains("No background preview"));
    assert!(texts(&call(dir.path(), "full", "hyperframes_preview", json!({"action":"stop"})).await.unwrap()).contains("stopped"));
    assert!(call(dir.path(), "full", "hyperframes_preview", json!({"port": 80})).await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn init_creates_a_new_folder_only() {
    let dir = project(r#"if [ "$1" = "init" ]; then mkdir -p "$2" && touch "$2/index.html" "$2/hyperframes.json"; fi"#);
    let result = call(dir.path(), "full", "hyperframes_init", json!({"name":"videos/intro","resolution":"portrait"})).await.unwrap();
    assert!(dir.path().join("videos/intro/index.html").is_file());
    assert!(texts(&result).contains("project=\"videos/intro\""));
    for bad in [json!({"name":"videos/intro"}), json!({"name":"../out"}), json!({"name":"/tmp/abs"}), json!({"name":"."}), json!({"name":"x","example":"-bad"}), json!({})] {
        assert!(call(dir.path(), "full", "hyperframes_init", bad.clone()).await.is_err(), "{bad}");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_project_subfolder_is_allowed_and_leaving_the_workspace_is_not() {
    let dir = project(COMMON);
    std::fs::create_dir_all(dir.path().join("videos/intro")).unwrap();
    assert!(call(dir.path(), "plan", "hyperframes_project", json!({"project":"videos/intro"})).await.is_ok());
    for bad in [json!({"project":"../"}), json!({"project":"/tmp"}), json!({"project":"missing"})] {
        assert!(call(dir.path(), "plan", "hyperframes_project", bad.clone()).await.is_err(), "{bad}");
    }
}

#[test]
fn a_missing_cli_explains_where_to_get_it_and_never_installs() {
    let dir = tempfile::tempdir().unwrap();
    if find_cli(dir.path()).is_some() {
        return; // this machine has a global install; the message is covered by the next call on a clean PATH
    }
    let error = tokio::runtime::Runtime::new().unwrap().block_on(call(dir.path(), "plan", "hyperframes_doctor", json!({}))).unwrap_err();
    assert!(error.to_string().contains(INSTALL_GUIDE) && error.to_string().contains("never installs"), "{error}");
}

#[test]
fn the_check_summary_survives_odd_reports() {
    let (summary, structured, ok) = summarize_check(&json!({"ok": true, "browserSkipped": true}), "check");
    assert!(ok && summary.contains("do NOT mean clean"));
    assert_eq!(structured["errors"], 0);
    let (summary, _, ok) = summarize_check(&json!({"ok": false, "errorCount": 2, "warningCount": 0, "findings": [{"severity":"error","code":"a","message":"x"},{"severity":"error","code":"b","message":"y"}]}), "lint");
    assert!(!ok && summary.starts_with("lint FAILED: 2 error(s)"));
}

#[cfg(unix)]
#[tokio::test]
async fn check_runs_as_if_in_ci_so_no_warm_browser_is_left_behind() {
    let dir = project(r#"
case "$1" in
  check) echo "{\"ok\":false,\"layout\":{\"errorCount\":1,\"findings\":[{\"severity\":\"error\",\"code\":\"env\",\"message\":\"CI=$CI\"}]}}";;
  lint) echo "{\"ok\":false,\"errorCount\":1,\"findings\":[{\"severity\":\"error\",\"code\":\"env\",\"message\":\"CI=[$CI]\"}]}";;
esac"#);
    assert!(texts(&call(dir.path(), "plan", "hyperframes_check", json!({})).await.unwrap()).contains("CI=1"));
    // Other commands keep the user's environment (no CI variable is invented for them).
    let lint = texts(&call(dir.path(), "plan", "hyperframes_check", json!({"scope":"lint"})).await.unwrap());
    assert!(lint.contains("CI=[") && !lint.contains("CI=[1]") || std::env::var_os("CI").is_some(), "{lint}");
}

const ADMIN: &str = r#"
case "$1" in
  doctor) echo '{"ok":false,"checks":[{"ok":false,"name":"Version","detail":"0.9.10 → 0.9.32 available"},{"ok":false,"name":"FFmpeg","detail":"Not found","hint":"apt install ffmpeg"}],"_meta":{"version":"0.9.10","latestVersion":"0.9.32","updateAvailable":true}}';;
  skills) case "$2" in
    check) echo '{"location":"/home/u/.claude/skills","agent":"claude-code","updateAvailable":true,"summary":{"current":3,"outdated":1,"missing":5,"coreMissing":0}}';;
    update) if [ -f "$PWD/fail-update" ]; then echo "network down" >&2; exit 1; fi; touch "$PWD/updated"; echo '{"ok":true}';;
  esac;;
esac
"#;

#[cfg(unix)]
#[tokio::test]
async fn settings_status_combines_the_environment_and_the_skills_state() {
    let dir = project(ADMIN);
    let status = admin_status(&dir.path().canonicalize().unwrap(), &CancellationToken::new()).await.unwrap();
    assert_eq!(status["found"], true);
    assert_eq!((status["version"].as_str(), status["latestVersion"].as_str(), status["updateAvailable"].as_bool()), (Some("0.9.10"), Some("0.9.32"), Some(true)));
    assert_eq!(status["problems"].as_array().unwrap().len(), 1, "only FFmpeg blocks work; the version nag does not");
    assert_eq!(status["skills"]["outdated"], 1);
    assert_eq!(status["skills"]["location"], "/home/u/.claude/skills");
    assert!(status["skills"]["updateAvailable"].as_bool().unwrap());
}

#[cfg(unix)]
#[tokio::test]
async fn updating_skills_runs_only_when_asked_and_reports_failures() {
    let dir = project(ADMIN);
    let root = dir.path().canonicalize().unwrap();
    admin_status(&root, &CancellationToken::new()).await.unwrap();
    assert!(!root.join("updated").exists(), "looking never changes the user's skills");
    admin_skills_update(&root, &CancellationToken::new()).await.unwrap();
    assert!(root.join("updated").exists());
    std::fs::write(root.join("fail-update"), "").unwrap();
    let error = admin_skills_update(&root, &CancellationToken::new()).await.unwrap_err();
    assert!(error.to_string().contains("network down"), "{error}");
}
