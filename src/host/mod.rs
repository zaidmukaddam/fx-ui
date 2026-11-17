pub mod git;
pub mod mac;
pub mod pickers;
pub mod shell;
pub mod store;
pub mod update;

pub fn printed(out: std::process::Output) -> Result<String, String> {
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}
