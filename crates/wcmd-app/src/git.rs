//! N-10: git worktrees. The few git commands WolfCmd runs: list a repository's worktrees and
//! branches, add a worktree, remove one. Git runs without a window, never prompts
//! (`GIT_TERMINAL_PROMPT=0`), with a timeout, and is killed with every process it started when
//! it takes longer. A process git started that outlives it (a hook's background job) never
//! holds a call up: its output is read for [`PIPE_GRACE`] after git exits, then left. Callers
//! run these on a blocking thread, never on the UI thread. Errors carry git's own message.

use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use specta::Type;

use crate::error::{ErrorKind, WcmdError};

/// Reading (rev-parse, worktree list, status) never takes longer than this.
const READ_TIMEOUT: Duration = Duration::from_secs(15);
/// Adding (a checkout) and removing (deleting the files) a large tree can take a while.
const CHANGE_TIMEOUT: Duration = Duration::from_secs(180);
/// A removal whose files are still held (a process that was in the folder closing) is tried
/// again this often, this many times.
const REMOVE_RETRY: Duration = Duration::from_millis(300);
const REMOVE_TRIES: u32 = 10;
/// After git exits, its output pipes are read this much longer at most: a process it started
/// that is still running (a hook's background job, a credential helper) keeps them open.
const PIPE_GRACE: Duration = Duration::from_secs(2);
/// What the UI says when there is no git to run.
const GIT_MISSING: &str = "Git isn't installed (or not on PATH)";

/// One worktree of a repository, as `git worktree list` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeInfo {
    /// Its folder, in the system's form (backslashes on Windows).
    pub(crate) path: String,
    /// The branch checked out (`feature/x`); `None`: a detached HEAD (or a bare main).
    pub(crate) branch: Option<String>,
    /// The commit checked out.
    pub(crate) head: Option<String>,
    /// The repository's main working tree (listed first by git).
    pub(crate) is_main: bool,
    /// Locked (`git worktree lock`): git refuses to remove it unless forced twice.
    pub(crate) locked: bool,
    /// Its folder is gone; `git worktree prune` would forget it.
    pub(crate) prunable: bool,
}

/// A folder's repository: which worktree the folder is in, the main one, every worktree and
/// the local branches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitRepository {
    /// The top of the worktree the folder is in.
    pub(crate) root: String,
    /// The main working tree (where new worktrees go next to by default).
    pub(crate) main_root: String,
    /// Every worktree, the main one first.
    pub(crate) worktrees: Vec<WorktreeInfo>,
    /// The local branches (`refs/heads`), sorted.
    pub(crate) branches: Vec<String>,
}

/// What a git run printed.
struct Output {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl Output {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    /// Git's own reason, without its `fatal:` / `error:` prefixes.
    fn reason(&self) -> String {
        let text = String::from_utf8_lossy(&self.stderr);
        let lines: Vec<&str> = text
            .lines()
            .map(|line| {
                let line = line.trim();
                ["fatal: ", "error: ", "warning: "]
                    .iter()
                    .find_map(|prefix| line.strip_prefix(prefix))
                    .unwrap_or(line)
            })
            .filter(|line| !line.is_empty())
            .collect();
        if lines.is_empty() {
            format!("git failed ({})", self.status)
        } else {
            lines.join("\n")
        }
    }
}

/// Why git gave no answer.
#[derive(Debug)]
enum RunError {
    /// There is no git to run (not installed, or not on PATH).
    Missing,
    /// It could not start, or took too long.
    Failed(WcmdError),
}

impl From<WcmdError> for RunError {
    fn from(error: WcmdError) -> Self {
        Self::Failed(error)
    }
}

impl From<RunError> for WcmdError {
    fn from(error: RunError) -> Self {
        match error {
            RunError::Missing => WcmdError::new(ErrorKind::Unavailable, GIT_MISSING),
            RunError::Failed(error) => error,
        }
    }
}

/// Which output pipe a chunk came from.
#[derive(Debug, Clone, Copy)]
enum Pipe {
    Out,
    Err,
}

/// A chunk read from a pipe; `None`: that pipe ended.
type Chunk = (Pipe, Option<Vec<u8>>);

/// Runs git in `dir` with `args`. `Ok` with whatever git answered (also a failure);
/// `Err` when git can't run or takes longer than `timeout`.
fn run<I, S>(dir: &Path, args: I, timeout: Duration) -> Result<Output, RunError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Never a prompt (credentials, an editor) nobody can answer, and plain messages.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C");
    // A repository chosen by the folder, not by the environment WolfCmd was started from.
    for name in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
    ] {
        command.env_remove(name);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        /// `CREATE_NO_WINDOW`: no console window flashes up.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            RunError::Missing
        } else {
            RunError::Failed(WcmdError::new(
                ErrorKind::Unavailable,
                format!("git could not start: {error}"),
            ))
        }
    })?;
    let (sender, chunks) = mpsc::channel();
    drain(child.stdout.take(), Pipe::Out, sender.clone());
    drain(child.stderr.take(), Pipe::Err, sender);
    let status = wait(&mut child, timeout)?;
    let (stdout, stderr) = collect(&chunks, Instant::now() + PIPE_GRACE);
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

/// Reads a pipe on its own thread (git blocks when a full pipe isn't read), sending what it
/// reads, then `None` at its end. The thread ends with the pipe, also after the reading side
/// stopped listening.
fn drain(pipe: Option<impl Read + Send + 'static>, which: Pipe, sender: Sender<Chunk>) {
    let Some(mut pipe) = pipe else {
        let _ = sender.send((which, None));
        return;
    };
    thread::spawn(move || {
        let mut buffer = vec![0; 16 * 1024];
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    if sender.send((which, Some(buffer[..n].to_vec()))).is_err() {
                        return;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        let _ = sender.send((which, None));
    });
}

/// Git's output once both pipes ended, or what came by `deadline`: a process git started that
/// still runs may hold the pipes open for any time, and is not waited for.
fn collect(chunks: &Receiver<Chunk>, deadline: Instant) -> (Vec<u8>, Vec<u8>) {
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut open = 2;
    while open > 0 {
        match chunks.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok((Pipe::Out, Some(bytes))) => stdout.extend_from_slice(&bytes),
            Ok((Pipe::Err, Some(bytes))) => stderr.extend_from_slice(&bytes),
            Ok((_, None)) => open -= 1,
            Err(RecvTimeoutError::Timeout) => {
                tracing::warn!("N-10: a process git started still holds its output; not waiting");
                break;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    (stdout, stderr)
}

/// The child's exit, or an error after killing it and every process it started when it
/// outlives `timeout`.
fn wait(child: &mut Child, timeout: Duration) -> Result<ExitStatus, WcmdError> {
    let deadline = Instant::now() + timeout;
    let mut pause = Duration::from_millis(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() >= deadline => {
                crate::platform::kill_tree(child);
                let _ = child.wait();
                return Err(WcmdError::new(
                    ErrorKind::Unavailable,
                    format!("git did not finish in {} s", timeout.as_secs()),
                ));
            }
            Ok(None) => {
                thread::sleep(pause);
                pause = (pause * 2).min(Duration::from_millis(50));
            }
            Err(error) => return Err(WcmdError::internal("waiting for git failed", &error)),
        }
    }
}

/// A path as git prints it (`C:/dev/app`) in the system's form (`C:\dev\app`).
fn native(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    // A drive root keeps its separator (`C:\`).
    let path = if trimmed.ends_with(':') {
        path
    } else {
        trimmed
    };
    if cfg!(windows) {
        path.replace('/', "\\")
    } else {
        path.to_owned()
    }
}

/// A path's identity for comparing: separators normalized, no trailing one, no case on
/// Windows.
fn key(path: &str) -> String {
    let unified = path.replace('\\', "/");
    let trimmed = unified.trim_end_matches('/');
    if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_owned()
    }
}

/// Whether two paths name the same folder: the same text (see [`key`]), or the same folder on
/// disk (a short 8.3 name, a junction).
fn same_path(a: &str, b: &str) -> bool {
    key(a) == key(b)
        || matches!(
            (std::fs::canonicalize(a), std::fs::canonicalize(b)),
            (Ok(a), Ok(b)) if a == b
        )
}

/// Whether `path` is `folder` or inside it.
fn is_within(path: &str, folder: &str) -> bool {
    let (path, folder) = (key(path), key(folder));
    path == folder || path.starts_with(&format!("{folder}/"))
}

/// Parses `git worktree list --porcelain -z`: fields end in NUL, a record ends in an empty
/// field. The main working tree comes first.
fn parse_worktrees(raw: &[u8]) -> Vec<WorktreeInfo> {
    let text = String::from_utf8_lossy(raw);
    let mut list = Vec::new();
    let mut current: Option<WorktreeInfo> = None;
    for field in text.split('\0') {
        if field.is_empty() {
            list.extend(current.take());
            continue;
        }
        let (name, value) = field.split_once(' ').unwrap_or((field, ""));
        if name == "worktree" {
            list.extend(current.take());
            current = Some(WorktreeInfo {
                path: native(value),
                branch: None,
                head: None,
                is_main: list.is_empty(),
                locked: false,
                prunable: false,
            });
            continue;
        }
        let Some(worktree) = current.as_mut() else {
            continue;
        };
        match name {
            "HEAD" => worktree.head = Some(value.to_owned()),
            "branch" => {
                let branch = value.strip_prefix("refs/heads/").unwrap_or(value);
                worktree.branch = Some(branch.to_owned());
            }
            "locked" => worktree.locked = true,
            "prunable" => worktree.prunable = true,
            _ => {}
        }
    }
    list.extend(current);
    list
}

/// The worktrees of `folder`'s repository; `None` when the folder isn't in a git working
/// tree (or git isn't installed: nothing to show then either).
pub(crate) fn worktrees(folder: &Path) -> Result<Option<GitRepository>, WcmdError> {
    if !folder.is_dir() {
        return Ok(None);
    }
    let top = match run(folder, ["rev-parse", "--show-toplevel"], READ_TIMEOUT) {
        Ok(output) if output.status.success() => output.text().trim().to_owned(),
        // Not in a repository, or no git: nothing to show either way.
        Ok(_) | Err(RunError::Missing) => return Ok(None),
        Err(RunError::Failed(error)) => return Err(error),
    };
    if top.is_empty() {
        return Ok(None);
    }
    let (list, branches) = thread::scope(|scope| {
        let list = scope.spawn(|| {
            run(
                folder,
                ["worktree", "list", "--porcelain", "-z"],
                READ_TIMEOUT,
            )
        });
        let branches = run(
            folder,
            ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
            READ_TIMEOUT,
        );
        (list.join(), branches)
    });
    let list =
        list.map_err(|_| WcmdError::new(ErrorKind::Internal, "listing worktrees failed"))??;
    if !list.status.success() {
        return Err(WcmdError::new(ErrorKind::Unavailable, list.reason()));
    }
    let worktrees = parse_worktrees(&list.stdout);
    let branches = branches?;
    let mut branches: Vec<String> = branches
        .text()
        .lines()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_owned)
        .collect();
    branches.sort();
    let root = native(&top);
    let main_root = worktrees
        .first()
        .map_or_else(|| root.clone(), |main| main.path.clone());
    Ok(Some(GitRepository {
        root,
        main_root,
        worktrees,
        branches,
    }))
}

/// The repository of `folder`, or an error saying it isn't one.
fn repository(folder: &Path) -> Result<GitRepository, WcmdError> {
    worktrees(folder)?.ok_or_else(|| {
        WcmdError::new(
            ErrorKind::NotFound,
            format!("{} isn't in a git repository", folder.display()),
        )
    })
}

/// Adds a worktree at `path` for `folder`'s repository: a new branch `branch` from the
/// folder's HEAD (`new_branch`), or the existing branch `branch`. Returns the worktree's path.
pub(crate) fn add(
    folder: &Path,
    branch: &str,
    new_branch: bool,
    path: &str,
) -> Result<String, WcmdError> {
    let branch = branch.trim();
    let path = native(path.trim());
    if branch.is_empty() {
        return Err(invalid("Name the branch"));
    }
    if !Path::new(&path).is_absolute() {
        return Err(invalid(
            "The location must be a full path (like C:\\dev\\app-fix)",
        ));
    }
    let repo = repository(folder)?;
    let check = run(
        folder,
        ["check-ref-format", "--branch", branch],
        READ_TIMEOUT,
    )?;
    if !check.status.success() {
        return Err(invalid(format!("\"{branch}\" isn't a valid branch name")));
    }
    validate_location(&repo, &path)?;
    let mut args: Vec<&str> = vec!["worktree", "add"];
    if new_branch {
        args.extend(["-b", branch, &path]);
    } else {
        args.extend([path.as_str(), branch]);
    }
    let output = run(folder, &args, CHANGE_TIMEOUT)?;
    if !output.status.success() {
        return Err(WcmdError::new(ErrorKind::Conflict, output.reason()));
    }
    tracing::info!(branch, new_branch, "N-10: worktree added");
    // Git's own form of the path, so the workspace's folder matches what git lists later.
    let listed = worktrees(folder).ok().flatten().and_then(|repo| {
        repo.worktrees
            .into_iter()
            .find(|w| same_path(&w.path, &path))
    });
    Ok(listed.map_or(path, |worktree| worktree.path))
}

fn invalid(message: impl Into<String>) -> WcmdError {
    WcmdError::new(ErrorKind::InvalidArgument, message)
}

/// A new worktree's folder is new (or empty), and not inside another linked worktree (inside
/// the main tree is allowed: `.worktrees/x` there is a common layout).
fn validate_location(repo: &GitRepository, path: &str) -> Result<(), WcmdError> {
    let target = Path::new(path);
    if target.exists() {
        let empty = target.is_dir()
            && std::fs::read_dir(target).is_ok_and(|mut entries| entries.next().is_none());
        if !empty {
            return Err(invalid(format!("{path} already exists and isn't empty")));
        }
    }
    for worktree in &repo.worktrees {
        if same_path(&worktree.path, path) {
            return Err(invalid(format!("{path} is already a worktree")));
        }
        if !worktree.is_main && is_within(path, &worktree.path) {
            return Err(invalid(format!(
                "{path} is inside the worktree {}",
                worktree.path
            )));
        }
    }
    Ok(())
}

/// Checks that the worktree at `path` can be removed: a linked worktree (never the main one)
/// without changes, unless `force`. Returns its repository's main working tree.
pub(crate) fn check_removable(path: &Path, force: bool) -> Result<String, WcmdError> {
    let repo = repository(path)?;
    let shown = path.display().to_string();
    let worktree = repo
        .worktrees
        .iter()
        .find(|w| same_path(&w.path, &shown))
        .ok_or_else(|| {
            WcmdError::new(ErrorKind::NotFound, format!("{shown} isn't a git worktree"))
        })?;
    if worktree.is_main {
        return Err(invalid(
            "The repository's main working tree can't be removed",
        ));
    }
    if force {
        return Ok(repo.main_root);
    }
    if worktree.locked {
        return Err(WcmdError::new(
            ErrorKind::Conflict,
            format!("{shown} is locked (git worktree lock)"),
        ));
    }
    let status = run(
        path,
        ["status", "--porcelain", "-z", "--untracked-files=normal"],
        READ_TIMEOUT,
    )?;
    if !status.status.success() {
        return Err(WcmdError::new(ErrorKind::Conflict, status.reason()));
    }
    let changed = changed_files(&status.stdout);
    if !changed.is_empty() {
        let mut names: Vec<&str> = changed.iter().take(3).map(String::as_str).collect();
        if changed.len() > 3 {
            names.push("…");
        }
        return Err(WcmdError::new(
            ErrorKind::Conflict,
            format!(
                "{shown} contains modified or untracked files ({})",
                names.join(", ")
            ),
        ));
    }
    Ok(repo.main_root)
}

/// The files `git status --porcelain -z` lists (a rename's old name is skipped).
fn changed_files(raw: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(raw);
    let mut files = Vec::new();
    let mut fields = text.split('\0').filter(|f| !f.is_empty());
    while let Some(field) = fields.next() {
        let (code, name) = (field.get(..2).unwrap_or(""), field.get(3..).unwrap_or(""));
        files.push(name.to_owned());
        if code.contains('R') || code.contains('C') {
            fields.next();
        }
    }
    files
}

/// Removes the worktree at `path` (run from `main_root`, so git never stands in the folder it
/// deletes). The branch is kept. A deletion that fails because a closing process still holds
/// a file is tried again (forced: git already checked the tree).
pub(crate) fn remove(main_root: &Path, path: &Path, force: bool) -> Result<(), WcmdError> {
    let mut forced = force;
    for attempt in 1..=REMOVE_TRIES {
        let mut args: Vec<&OsStr> = vec![OsStr::new("worktree"), OsStr::new("remove")];
        if forced {
            // Twice: a locked worktree too.
            args.extend([OsStr::new("--force"), OsStr::new("--force")]);
        }
        args.push(path.as_os_str());
        let output = run(main_root, &args, CHANGE_TIMEOUT)?;
        if output.status.success() {
            tracing::info!(force, attempt, "N-10: worktree removed");
            return Ok(());
        }
        let reason = output.reason();
        if !reason.contains("failed to delete") || attempt == REMOVE_TRIES {
            return Err(WcmdError::new(ErrorKind::Conflict, reason));
        }
        tracing::debug!(%reason, attempt, "N-10: worktree files still held; trying again");
        forced = true;
        thread::sleep(REMOVE_RETRY);
    }
    unreachable!("the last attempt returns")
}

/// `PathBuf` from a path the UI sent, refused when it isn't a full path.
pub(crate) fn absolute(path: &str) -> Result<PathBuf, WcmdError> {
    let path = PathBuf::from(native(path.trim()));
    if path.is_absolute() {
        Ok(path)
    } else {
        Err(invalid(format!("{} isn't a full path", path.display())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A temporary folder with spaces in its path, removed when dropped.
    struct Temp(PathBuf);

    impl Temp {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("wcmd n10 {name} {}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn join(&self, part: &str) -> PathBuf {
            self.0.join(part)
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn git_ok(dir: &Path, args: &[&str]) -> String {
        let output = run(dir, args, READ_TIMEOUT).unwrap();
        assert!(output.status.success(), "git {args:?}: {}", output.reason());
        output.text()
    }

    /// A repository `my repo` (branch `main`, one commit) in `temp`.
    fn repository_in(temp: &Temp) -> PathBuf {
        let repo = temp.join("my repo");
        std::fs::create_dir_all(&repo).unwrap();
        git_ok(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("readme.txt"), "hello\n").unwrap();
        git_ok(&repo, &["add", "."]);
        git_ok(
            &repo,
            &[
                "-c",
                "user.name=WolfCmd",
                "-c",
                "user.email=test@wolfcmd.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-q",
                "-m",
                "first",
            ],
        );
        repo
    }

    fn text(path: &Path) -> String {
        path.display().to_string()
    }

    #[test]
    fn n10_a_folder_outside_a_repository_has_no_worktrees() {
        let temp = Temp::new("outside");
        assert_eq!(worktrees(&temp.0).unwrap(), None);
        assert_eq!(worktrees(&temp.join("missing")).unwrap(), None);
    }

    #[test]
    fn n10_worktrees_are_added_listed_and_removed_with_real_git() {
        let temp = Temp::new("lifecycle");
        let repo = repository_in(&temp);
        git_ok(&repo, &["branch", "existing"]);

        let listed = worktrees(&repo).unwrap().expect("a repository");
        assert!(same_path(&listed.root, &text(&repo)));
        assert_eq!(listed.root, listed.main_root);
        assert_eq!(listed.branches, vec!["existing", "main"]);
        assert_eq!(listed.worktrees.len(), 1);
        assert!(listed.worktrees[0].is_main);
        assert_eq!(listed.worktrees[0].branch.as_deref(), Some("main"));

        // A new branch from HEAD, at a path with spaces.
        let at = temp.join("my repo.worktrees").join("fix one");
        let fix = add(&repo, "fix/bug-1", true, &text(&at)).unwrap();
        assert!(same_path(&fix, &text(&at)));
        assert!(Path::new(&fix).join("readme.txt").is_file());
        // An existing branch.
        let other = add(&repo, "existing", false, &text(&temp.join("other tree"))).unwrap();

        let listed = worktrees(Path::new(&fix)).unwrap().expect("a repository");
        assert!(same_path(&listed.root, &fix));
        assert!(same_path(&listed.main_root, &text(&repo)));
        let branches: Vec<(Option<&str>, bool)> = listed
            .worktrees
            .iter()
            .map(|w| (w.branch.as_deref(), w.is_main))
            .collect();
        assert_eq!(
            branches,
            vec![
                (Some("main"), true),
                (Some("fix/bug-1"), false),
                (Some("existing"), false)
            ]
        );
        assert_eq!(
            git_ok(Path::new(&fix), &["branch", "--show-current"]).trim(),
            "fix/bug-1"
        );

        // A branch checked out elsewhere: git says why.
        let taken = add(&repo, "main", false, &text(&temp.join("taken"))).unwrap_err();
        assert_eq!(taken.kind, ErrorKind::Conflict);
        assert!(taken.message.contains("main"), "{}", taken.message);

        // A clean worktree is removed; its branch stays.
        let main_root = check_removable(Path::new(&other), false).unwrap();
        remove(Path::new(&main_root), Path::new(&other), false).unwrap();
        assert!(!Path::new(&other).exists());
        assert!(git_ok(&repo, &["branch", "--list", "existing"]).contains("existing"));

        // One with changes is refused (and kept) unless forced.
        std::fs::write(Path::new(&fix).join("new file.txt"), "work\n").unwrap();
        let dirty = check_removable(Path::new(&fix), false).unwrap_err();
        assert_eq!(dirty.kind, ErrorKind::Conflict);
        assert!(dirty.message.contains("new file.txt"), "{}", dirty.message);
        assert!(Path::new(&fix).join("new file.txt").is_file());
        let main_root = check_removable(Path::new(&fix), true).unwrap();
        remove(Path::new(&main_root), Path::new(&fix), true).unwrap();
        assert!(!Path::new(&fix).exists());
        let listed = worktrees(&repo).unwrap().expect("a repository");
        assert_eq!(listed.worktrees.len(), 1);
        assert!(listed.branches.contains(&"fix/bug-1".to_owned()));
    }

    #[test]
    fn n10_bad_locations_and_names_are_refused() {
        let temp = Temp::new("refused");
        let repo = repository_in(&temp);
        std::fs::create_dir_all(temp.join("full")).unwrap();
        std::fs::write(temp.join("full").join("file.txt"), "x").unwrap();
        let kind = |result: Result<String, WcmdError>| result.unwrap_err().kind;
        let at = |part: &str| text(&temp.join(part));
        assert_eq!(
            kind(add(&repo, "a", true, &at("full"))),
            ErrorKind::InvalidArgument
        );
        assert_eq!(
            kind(add(&repo, "a", true, "relative\\path")),
            ErrorKind::InvalidArgument
        );
        assert_eq!(
            kind(add(&repo, "bad..name", true, &at("x"))),
            ErrorKind::InvalidArgument
        );
        assert_eq!(
            kind(add(&repo, " ", true, &at("x"))),
            ErrorKind::InvalidArgument
        );
        assert_eq!(
            kind(add(&repo, "a", true, &text(&repo))),
            ErrorKind::InvalidArgument
        );
        // Inside a linked worktree: refused; inside the main tree (a `.worktrees` folder): fine.
        let linked = add(&repo, "linked", true, &at("linked")).unwrap();
        assert_eq!(
            kind(add(
                &repo,
                "b",
                true,
                &text(&Path::new(&linked).join("nested"))
            )),
            ErrorKind::InvalidArgument
        );
        add(&repo, "c", true, &text(&repo.join(".worktrees").join("c"))).unwrap();
        // The main working tree is never removed; a plain folder isn't a worktree.
        assert_eq!(
            check_removable(&repo, true).unwrap_err().kind,
            ErrorKind::InvalidArgument
        );
        assert_eq!(
            check_removable(&temp.join("full"), true).unwrap_err().kind,
            ErrorKind::NotFound
        );
    }

    /// A process git started that outlives it (here an alias's background `ping`, holding git's
    /// output pipe for 30 s) never holds the call up: git's answer comes within the grace.
    #[cfg(windows)]
    #[test]
    fn n10_a_process_left_holding_gits_output_never_hangs_it() {
        let temp = Temp::new("linger");
        let started = Instant::now();
        let output = run(
            &temp.0,
            [
                "-c",
                "alias.linger=!echo started; ping -n 30 127.0.0.1 &",
                "linger",
            ],
            READ_TIMEOUT,
        )
        .unwrap();
        assert!(output.status.success(), "{}", output.reason());
        assert!(output.text().contains("started"), "{}", output.text());
        assert!(
            started.elapsed() < Duration::from_secs(15),
            "{:?}",
            started.elapsed()
        );
    }

    /// Whether a `ping.exe` whose command line names `target` is running.
    #[cfg(windows)]
    fn ping_running(target: &str) -> bool {
        let script = format!(
            "@(Get-CimInstance Win32_Process -Filter \"Name='PING.EXE'\" | Where-Object \
             {{ $_.CommandLine -like '*{target}*' }}).Count"
        );
        let output = crate::platform::background_command("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout).trim() != "0"
    }

    /// Git that takes too long is ended with every process it started (here an alias's `ping`
    /// through `sh`), and the call returns at its timeout.
    #[cfg(windows)]
    #[test]
    fn n10_a_git_past_its_timeout_is_ended_with_its_children() {
        let temp = Temp::new("hang");
        let started = Instant::now();
        let Err(RunError::Failed(error)) = run(
            &temp.0,
            ["-c", "alias.hang=!ping -n 60 127.0.0.31", "hang"],
            Duration::from_secs(3),
        ) else {
            panic!("git should have been ended at its timeout");
        };
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(
            error.message.contains("did not finish"),
            "{}",
            error.message
        );
        let until = Instant::now() + Duration::from_secs(10);
        while ping_running("127.0.0.31") {
            assert!(Instant::now() < until, "the hook's process still runs");
            thread::sleep(Duration::from_millis(200));
        }
    }

    #[test]
    fn n10_a_missing_git_is_its_own_error() {
        let error: WcmdError = RunError::Missing.into();
        assert_eq!(error.kind, ErrorKind::Unavailable);
        assert_eq!(error.message, GIT_MISSING);
    }

    #[test]
    fn n10_porcelain_lists_parse() {
        let raw = b"worktree C:/dev/my app\0HEAD 1111\0branch refs/heads/main\0\0\
worktree C:/dev/my app.worktrees/fix\0HEAD 2222\0detached\0locked moving\0\0\
worktree D:/gone\0HEAD 3333\0branch refs/heads/old\0prunable gitdir points nowhere\0\0";
        let list = parse_worktrees(raw);
        assert_eq!(list.len(), 3);
        assert!(list[0].is_main && !list[1].is_main && !list[2].is_main);
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(list[1].branch, None);
        assert_eq!(list[1].head.as_deref(), Some("2222"));
        assert!(list[1].locked && !list[1].prunable);
        assert!(list[2].prunable && !list[2].locked);
        if cfg!(windows) {
            assert_eq!(list[1].path, r"C:\dev\my app.worktrees\fix");
            assert_eq!(native("C:/"), r"C:\");
        }
        assert_eq!(
            changed_files(b" M a.txt\0R  new name.txt\0old name.txt\0?? b c.txt\0"),
            vec!["a.txt", "new name.txt", "b c.txt"]
        );
        assert!(is_within(r"C:\Dev\App\sub", "c:/dev/app"));
        assert!(!is_within(r"C:\dev\app-fix", r"C:\dev\app"));
    }
}
