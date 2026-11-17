use anyhow::{Context as _, Result, anyhow};
use serde_json::{Value, json};
use smol::channel::{Receiver, Sender, bounded, unbounded};
use smol::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use smol::process::{ChildStdin, Command, Stdio};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

pub struct Agent {
    stdin: smol::lock::Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, Sender<Result<Value>>>>,
    next_id: AtomicU64,
    version: Mutex<Option<String>>,
    child: Mutex<smol::process::Child>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Recovery {
    pub state: String,
    pub attempt: u64,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Steered {
    Absorbed,
    Dropped,
    Missed,
}

fn profile_mcp() -> Value {
    json!({ "fx": { "profileMcpServers": true } })
}

pub fn image_block(mime: &str, bytes: &[u8]) -> Value {
    use base64::Engine as _;
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    json!({ "type": "image", "mimeType": mime, "data": data })
}

pub fn image_bytes(data: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(data).ok()
}

#[derive(Debug, Clone)]
pub enum Event {
    Update {
        session: String,
        update: Update,
    },
    Permission {
        request: Value,
        session: String,
        call: ToolCall,
        options: Vec<PermissionOption>,
    },
    Exited(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Update {
    UserText(String),
    UserImage {
        mime: String,
        data: String,
    },
    Recovery(Option<Recovery>),
    Text(String),
    Thought(String),
    ToolCall(ToolCall),
    ToolChange {
        id: String,
        status: Option<String>,
        output: Option<String>,
    },
    Title(String),
    Usage {
        used: u64,
        size: u64,
    },
    Notice(String),
    Other,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub title: String,
    pub kind: String,
    pub status: String,
    pub input: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PermissionOption {
    pub id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ConfigOption {
    pub id: String,
    pub name: String,
    pub current: String,
    pub choices: Vec<Choice>,
}

pub fn is_on(value: &str) -> bool {
    value == "on" || value == "true"
}

#[derive(Debug, Clone, PartialEq)]
pub struct SavedSession {
    pub id: String,
    pub title: String,
    pub updated: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Choice {
    pub value: String,
    pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Launch {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub mode: Option<String>,
}

impl Launch {
    fn args(&self) -> Vec<&str> {
        let mut args = vec!["acp"];
        if let Some(mode) = &self.mode {
            args.extend(["--permission-mode", mode]);
        }
        if let Some(provider) = &self.provider {
            args.extend(["--provider", provider]);
        }
        if let Some(model) = &self.model {
            args.extend(["--model", model]);
        }
        args
    }
}

impl Agent {
    pub async fn start(
        binary: &str,
        cwd: &Path,
        launch: &Launch,
    ) -> Result<(std::sync::Arc<Agent>, Receiver<Event>)> {
        let mut child = Command::new(binary)
            .args(launch.args())
            .current_dir(cwd)
            .env("PATH", crate::host::shell::path())
            .env_remove("AI_GATEWAY_API_KEY")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("could not start `{binary} acp`"))?;
        let stdin = child.stdin.take().context("no stdin")?;
        let stdout = child.stdout.take().context("no stdout")?;

        let agent = std::sync::Arc::new(Agent {
            stdin: smol::lock::Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
            version: Mutex::new(None),
            child: Mutex::new(child),
        });
        let (events, rx) = unbounded();
        smol::spawn(read_loop(agent.clone(), BufReader::new(stdout), events)).detach();

        let greeted = agent
            .request(
                "initialize",
                json!({ "protocolVersion": 1, "clientCapabilities": {} }),
            )
            .await;
        let info = match greeted {
            Ok(info) => info,
            Err(e) => {
                agent.stop();
                return Err(e);
            }
        };
        *agent.version.lock().unwrap() = info["agentInfo"]["version"].as_str().map(str::to_string);
        Ok((agent, rx))
    }

    pub fn stop(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }

    pub fn version(&self) -> Option<String> {
        self.version.lock().unwrap().clone()
    }

    pub async fn list_sessions(&self, cwd: &Path) -> Result<Vec<SavedSession>> {
        let result = self.request("session/list", json!({ "cwd": cwd })).await?;
        Ok(result["sessions"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|s| SavedSession {
                id: str_at(s, "sessionId"),
                title: str_at(s, "title"),
                updated: str_at(s, "updatedAt"),
            })
            .collect())
    }

    pub async fn load_session(&self, session: &str, cwd: &Path) -> Result<Vec<ConfigOption>> {
        let result = self
            .request(
                "session/load",
                json!({ "sessionId": session, "cwd": cwd, "mcpServers": [], "_meta": profile_mcp() }),
            )
            .await?;
        Ok(parse_options(&result["configOptions"]))
    }

    pub async fn new_session(
        &self,
        cwd: &Path,
        instructions: Option<&str>,
    ) -> Result<(String, Vec<ConfigOption>)> {
        let mut params = json!({ "cwd": cwd, "mcpServers": [], "_meta": profile_mcp() });
        if let Some(text) = instructions.filter(|t| !t.trim().is_empty()) {
            params["systemPrompt"] = json!([{ "type": "text", "text": text }]);
        }
        let result = self.request("session/new", params).await?;
        let id = result["sessionId"]
            .as_str()
            .context("no sessionId")?
            .to_string();
        Ok((id, parse_options(&result["configOptions"])))
    }

    pub async fn set_option(
        &self,
        session: &str,
        option: &str,
        value: &str,
    ) -> Result<Vec<ConfigOption>> {
        let result = self
            .request(
                "session/set_config_option",
                json!({ "sessionId": session, "configId": option, "value": value }),
            )
            .await?;
        Ok(parse_options(&result["configOptions"]))
    }

    pub async fn prompt(&self, session: &str, blocks: Vec<Value>) -> Result<String> {
        let result = self
            .request(
                "session/prompt",
                json!({ "sessionId": session, "prompt": blocks }),
            )
            .await?;
        Ok(result["stopReason"]
            .as_str()
            .unwrap_or("end_turn")
            .to_string())
    }

    pub async fn steer(&self, session: &str, text: &str) -> Steered {
        let sent = self
            .request(
                "session/prompt",
                json!({
                    "sessionId": session,
                    "prompt": [{ "type": "text", "text": text }],
                    "_meta": { "fx": { "steer": true } },
                }),
            )
            .await;
        match sent {
            Ok(result) if result["_meta"]["fx"]["steering"] == "dropped" => Steered::Dropped,
            Ok(_) => Steered::Absorbed,
            Err(_) => Steered::Missed,
        }
    }

    pub async fn cancel(&self, session: &str) -> Result<()> {
        self.write(json!({ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": session } }))
            .await
    }

    pub async fn answer_permission(&self, request: Value, option: Option<&str>) -> Result<()> {
        let outcome = match option {
            Some(id) => json!({ "outcome": "selected", "optionId": id }),
            None => json!({ "outcome": "cancelled" }),
        };
        self.write(json!({ "jsonrpc": "2.0", "id": request, "result": { "outcome": outcome } }))
            .await
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = bounded(1);
        self.pending.lock().unwrap().insert(id, tx);
        let sent = self
            .write(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await;
        if let Err(e) = sent {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        rx.recv()
            .await
            .map_err(|_| anyhow!("fx exited before answering {method}"))?
    }

    async fn write(&self, message: Value) -> Result<()> {
        let mut line = serde_json::to_vec(&message)?;
        line.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(&line).await?;
        stdin.flush().await?;
        Ok(())
    }
}

async fn read_loop(
    agent: std::sync::Arc<Agent>,
    stdout: BufReader<smol::process::ChildStdout>,
    events: Sender<Event>,
) {
    let mut lines = stdout.lines();
    use smol::stream::StreamExt as _;
    while let Some(Ok(line)) = lines.next().await {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match route(&message) {
            Routed::Response(id, result) => {
                if let Some(tx) = agent.pending.lock().unwrap().remove(&id) {
                    let _ = tx.try_send(result);
                }
            }
            Routed::Event(event) => {
                let _ = events.send(event).await;
            }
            Routed::Unhandled(id) => {
                let _ = agent
                    .write(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "not supported" } }))
                    .await;
            }
            Routed::Ignore => {}
        }
    }
    agent.pending.lock().unwrap().clear();
    let _ = events.send(Event::Exited("fx stopped".into())).await;
}

#[allow(clippy::large_enum_variant)]
enum Routed {
    Response(u64, Result<Value>),
    Event(Event),
    Unhandled(Value),
    Ignore,
}

fn route(message: &Value) -> Routed {
    let method = message["method"].as_str();
    let id = message.get("id");
    match (method, id) {
        (None, Some(id)) => {
            let Some(id) = id.as_u64() else {
                return Routed::Ignore;
            };
            let result = match message.get("error") {
                Some(error) => Err(anyhow!(
                    "{}",
                    error["message"].as_str().unwrap_or("request failed")
                )),
                None => Ok(message["result"].clone()),
            };
            Routed::Response(id, result)
        }
        (Some("session/request_permission"), Some(id)) => {
            let params = &message["params"];
            Routed::Event(Event::Permission {
                request: id.clone(),
                session: str_at(params, "sessionId"),
                call: parse_tool_call(&params["toolCall"]),
                options: params["options"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|o| PermissionOption {
                        id: str_at(o, "optionId"),
                        name: str_at(o, "name"),
                        kind: str_at(o, "kind"),
                    })
                    .collect(),
            })
        }
        (Some(_), Some(id)) => Routed::Unhandled(id.clone()),
        (Some("session/update"), None) => Routed::Event(Event::Update {
            session: str_at(&message["params"], "sessionId"),
            update: parse_update(&message["params"]["update"]),
        }),
        _ => Routed::Ignore,
    }
}

pub fn parse_update(update: &Value) -> Update {
    let text = || {
        update["content"]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    };
    match update["sessionUpdate"].as_str().unwrap_or_default() {
        "user_message_chunk" if update["content"]["type"] == "image" => Update::UserImage {
            mime: str_at(&update["content"], "mimeType"),
            data: str_at(&update["content"], "data"),
        },
        "user_message_chunk" => Update::UserText(text()),
        "agent_message_chunk" if is_notice(&text()) => Update::Notice(text()),
        "agent_message_chunk" => Update::Text(text()),
        "agent_thought_chunk" => Update::Thought(text()),
        "tool_call" => Update::ToolCall(parse_tool_call(update)),
        "tool_call_update" => Update::ToolChange {
            id: str_at(update, "toolCallId"),
            status: update["status"].as_str().map(str::to_string),
            output: update["content"].as_array().map(|parts| {
                parts
                    .iter()
                    .filter_map(|p| p["content"]["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("")
            }),
        },
        "session_info_update" => {
            let fx = &update["_meta"]["fx"];
            match (fx.get("modelResponseRecovery"), update["title"].as_str()) {
                (Some(Value::Null), _) => Update::Recovery(None),
                (Some(retry), _) => Update::Recovery(Some(Recovery {
                    state: str_at(retry, "state"),
                    attempt: retry["attempt"].as_u64().unwrap_or(0),
                    message: str_at(retry, "message"),
                })),
                (None, Some(title)) => Update::Title(title.to_string()),
                (None, None) => Update::Other,
            }
        }
        "usage_update" => Update::Usage {
            used: update["used"].as_u64().unwrap_or(0),
            size: update["size"].as_u64().unwrap_or(0),
        },
        _ => Update::Other,
    }
}

fn is_notice(text: &str) -> bool {
    let mut lines = text.lines().filter(|l| !l.trim().is_empty()).peekable();
    lines.peek().is_some()
        && lines.all(|l| l.starts_with("[context] ") || l.starts_with("skill discovery warning:"))
}

fn parse_tool_call(call: &Value) -> ToolCall {
    ToolCall {
        id: str_at(call, "toolCallId"),
        name: str_at(call, "name"),
        title: str_at(call, "title"),
        kind: str_at(call, "kind"),
        status: call["status"].as_str().unwrap_or("pending").to_string(),
        input: call["rawInput"].clone(),
    }
}

fn parse_options(options: &Value) -> Vec<ConfigOption> {
    options
        .as_array()
        .into_iter()
        .flatten()
        .map(|o| ConfigOption {
            id: str_at(o, "id"),
            name: str_at(o, "name"),
            current: str_at(o, "currentValue"),
            choices: o["options"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|c| Choice {
                    value: str_at(c, "value"),
                    name: str_at(c, "name"),
                })
                .collect(),
        })
        .collect()
}

fn str_at(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> Routed {
        route(&serde_json::from_str(line).unwrap())
    }

    #[test]
    fn reads_retries_titles_and_images() {
        let update = |json: &str| parse_update(&serde_json::from_str::<Value>(json).unwrap());
        assert_eq!(
            update(
                r#"{"sessionUpdate":"session_info_update","_meta":{"fx":{"modelResponseRecovery":{"state":"retrying","attempt":3,"message":"The gateway is overloaded"}}}}"#
            ),
            Update::Recovery(Some(Recovery {
                state: "retrying".into(),
                attempt: 3,
                message: "The gateway is overloaded".into(),
            }))
        );
        assert_eq!(
            update(
                r#"{"sessionUpdate":"session_info_update","_meta":{"fx":{"modelResponseRecovery":null}}}"#
            ),
            Update::Recovery(None)
        );
        assert_eq!(
            update(r#"{"sessionUpdate":"session_info_update","title":"Fix the bug"}"#),
            Update::Title("Fix the bug".into())
        );
        assert_eq!(
            update(
                r#"{"sessionUpdate":"user_message_chunk","content":{"type":"image","mimeType":"image/png","data":"aGk="}}"#
            ),
            Update::UserImage {
                mime: "image/png".into(),
                data: "aGk=".into(),
            }
        );
        assert_eq!(image_bytes("aGk=").unwrap(), b"hi");
        assert_eq!(image_block("image/png", b"hi")["data"], "aGk=");
    }

    #[test]
    fn folds_a_recorded_turn() {
        let Routed::Event(Event::Update { session, update }) = parse(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call","toolCallId":"c1","name":"shell","title":"Running","kind":"execute","status":"pending","rawInput":{"action":"run","command":"ls"}}}}"#,
        ) else {
            panic!("tool_call should be an update")
        };
        assert_eq!(session, "s1");
        let Update::ToolCall(call) = update else {
            panic!()
        };
        assert_eq!(
            (call.name.as_str(), call.kind.as_str()),
            ("shell", "execute")
        );
        assert_eq!(call.input["command"], "ls");

        let Routed::Event(Event::Update { update, .. }) = parse(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call_update","toolCallId":"c1","status":"completed","content":[{"type":"content","content":{"type":"text","text":"hello.txt\n"}}]}}}"#,
        ) else {
            panic!()
        };
        assert_eq!(
            update,
            Update::ToolChange {
                id: "c1".into(),
                status: Some("completed".into()),
                output: Some("hello.txt\n".into())
            }
        );

        let Routed::Event(Event::Update { update, .. }) = parse(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Done."}}}}"#,
        ) else {
            panic!()
        };
        assert_eq!(update, Update::Text("Done.".into()));

        let chunk = |text: &str| {
            parse_update(&json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": text },
            }))
        };
        assert!(matches!(
            chunk("[context] skill descriptions shortened: 3\n[context] skill catalog shortened\n"),
            Update::Notice(_)
        ));
        assert!(matches!(
            chunk("skill discovery warning: candidate \"x\" was skipped"),
            Update::Notice(_)
        ));
        assert_eq!(chunk("[x] done"), Update::Text("[x] done".into()));
        assert_eq!(
            chunk("[1] is the first item"),
            Update::Text("[1] is the first item".into())
        );
    }

    #[test]
    fn a_permission_request_carries_its_id_and_options() {
        let Routed::Event(Event::Permission {
            request,
            call,
            options,
            ..
        }) = parse(
            r#"{"jsonrpc":"2.0","id":1,"method":"session/request_permission","params":{"sessionId":"s1","toolCall":{"toolCallId":"c9","name":"shell","title":"shell.run echo hi","kind":"execute","status":"pending","rawInput":{"action":"run","command":"echo hi"}},"options":[{"optionId":"allow_once","name":"Allow once","kind":"allow_once"},{"optionId":"allow_always","name":"Allow for this session","kind":"allow_always"},{"optionId":"reject_once","name":"Reject","kind":"reject_once"}]}}"#,
        )
        else {
            panic!("should be a permission event")
        };
        assert_eq!(request, json!(1));
        assert_eq!(call.input["command"], "echo hi");
        let kinds: Vec<_> = options.iter().map(|o| o.kind.as_str()).collect();
        assert_eq!(kinds, ["allow_once", "allow_always", "reject_once"]);
    }

    #[test]
    fn responses_and_unknown_requests_route_apart() {
        assert!(matches!(
            parse(r#"{"jsonrpc":"2.0","id":4,"result":{"stopReason":"end_turn"}}"#),
            Routed::Response(4, Ok(_))
        ));
        assert!(matches!(
            parse(r#"{"jsonrpc":"2.0","id":5,"error":{"code":1,"message":"no"}}"#),
            Routed::Response(5, Err(_))
        ));
        assert!(matches!(
            parse(r#"{"jsonrpc":"2.0","id":6,"method":"fs/read_text_file","params":{}}"#),
            Routed::Unhandled(_)
        ));
    }

    #[test]
    #[ignore]
    fn live_handshake_and_new_session() {
        smol::block_on(async {
            let dir = std::env::temp_dir();
            let (agent, _events) = Agent::start("fx", &dir, &Launch::default()).await.unwrap();
            let (session, options) = agent.new_session(&dir, None).await.unwrap();
            assert!(!session.is_empty());
            let ids: Vec<_> = options.iter().map(|o| o.id.as_str()).collect();
            for id in ["provider", "model", "mode"] {
                assert!(ids.contains(&id), "missing {id} in {ids:?}");
            }
            assert!(agent.version().is_some());
            agent
                .list_sessions(&dir.canonicalize().unwrap())
                .await
                .unwrap();
        });
    }

    #[test]
    #[ignore]
    fn live_accounts_run_side_by_side() {
        let saved_default = || {
            let home = std::env::var("HOME").unwrap();
            let text = std::fs::read_to_string(format!("{home}/.fx/settings.json")).unwrap();
            serde_json::from_str::<Value>(&text).unwrap()["provider"]
                .as_str()
                .map(str::to_string)
        };
        let before = saved_default();
        smol::block_on(async {
            let dir = std::env::temp_dir();
            let current = |options: &[ConfigOption], id: &str| {
                options.iter().find(|o| o.id == id).unwrap().current.clone()
            };
            let on = |provider: &str| Launch {
                provider: Some(provider.into()),
                ..Launch::default()
            };
            let (codex, _a) = Agent::start("fx", &dir, &on("codex")).await.unwrap();
            let (grok, _b) = Agent::start("fx", &dir, &on("grok")).await.unwrap();
            let (in_codex, options) = codex.new_session(&dir, None).await.unwrap();
            assert_eq!(current(&options, "provider"), "codex");
            let model = options
                .iter()
                .find(|o| o.id == "model")
                .and_then(|o| o.choices.iter().find(|c| !c.value.contains('/')))
                .map(|c| c.value.clone())
                .unwrap();
            let (_, options) = grok.new_session(&dir, None).await.unwrap();
            assert_eq!(current(&options, "provider"), "grok");
            let options = codex.set_option(&in_codex, "model", &model).await.unwrap();
            assert_eq!(current(&options, "provider"), "codex");
            assert_eq!(current(&options, "model"), model);
            codex.new_session(&dir, None).await.unwrap();
            let refused = codex.set_option(&in_codex, "model", &model).await;
            assert!(
                refused.is_err(),
                "fx now keeps two sessions live in one process"
            );
        });
        assert_eq!(saved_default(), before);
    }
}
