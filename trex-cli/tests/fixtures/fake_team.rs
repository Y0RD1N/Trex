//! No network, GUI or provider calls. Exercises the real CLI bridge boundary.
use std::{fs,io::{Read,Write},path::Path,thread,time::Duration};
fn main(){
    let args:Vec<_>=std::env::args().skip(1).collect();assert_eq!(args.len(),4);assert_eq!(args[0],"--trex-team-call");
    assert!(!std::env::vars().any(|(key,_)|key.ends_with("API_KEY")||key=="TREX_HOME"));
    let mut input=String::new();std::io::stdin().read_to_string(&mut input).unwrap();
    let mut log=fs::OpenOptions::new().create(true).append(true).open(Path::new(&args[1]).join("team-calls.jsonl")).unwrap();writeln!(log,"{input}").unwrap();log.sync_all().unwrap();
    if input.contains("hold-task"){thread::sleep(Duration::from_secs(20));}
    if input.contains("malformed"){print!("{{invalid");return;}
    let status=if input.contains("uncertain-task"){ "uncertain" }else{"completed"};
    print!("{{\"content\":[{{\"type\":\"text\",\"text\":\"Worker report: tests passed\"}}],\"structuredContent\":{{\"task\":{{\"id\":\"task-1\",\"status\":\"{status}\",\"report\":\"Worker report: tests passed\"}}}},\"isError\":false}}");
}
