# WolfCmd shell integration for bash (Git Bash and bash inside WSL; N-02).
#
# In WSL it is started with `bash --rcfile <this> -i` and WOLFCMD_BASH_LOGIN=1 (WSL's own
# launch is a login shell too); the folder is then a Linux path (see below).
#
# Loaded with `bash --init-file <this> -i`, so it replaces the startup files bash would read:
# it reads them itself first (as a login shell when WOLFCMD_BASH_LOGIN=1), then wraps the
# user's prompt. It never replaces the prompt or edits any file.
#
# Reports: OSC 7 (folder, as a Windows path), OSC 133;A/B (prompt start/end), 133;C (command
# start, via PS0), 133;D;<exit code> (command end). No subshells per prompt: forks are slow
# on Windows.

if [ -n "$WOLFCMD_BASH_LOGIN" ]; then
  unset WOLFCMD_BASH_LOGIN
  # What a login shell (`bash --login`) reads.
  [ -r /etc/profile ] && . /etc/profile
  if [ -r ~/.bash_profile ]; then
    . ~/.bash_profile
  elif [ -r ~/.bash_login ]; then
    . ~/.bash_login
  elif [ -r ~/.profile ]; then
    . ~/.profile
  fi
else
  [ -r ~/.bashrc ] && . ~/.bashrc
fi

if [ -z "$__wolfcmd_integrated" ]; then
  __wolfcmd_integrated=1
  __wolfcmd_prompts=0
  # The mount table, read once: "/" is C:/Program Files/Git, "/tmp" the user's temp folder,
  # "/c" is C:. Paths in /proc/mounts escape spaces as \040.
  __wolfcmd_mount_win=()
  __wolfcmd_mount_posix=()
  # N-02: inside WSL the folder stays a Linux path (/mnt/c/x becomes C:/x), and the mount
  # table is not read: /proc/mounts lists the drives as "C:\134", which isn't a Windows path.
  __wolfcmd_wsl=
  [ -n "${WSL_DISTRO_NAME:-}" ] && __wolfcmd_wsl=1
  if [ -z "$__wolfcmd_wsl" ] && [ -r /proc/mounts ]; then
    while read -r __wolfcmd_w __wolfcmd_p __wolfcmd_rest; do
      case $__wolfcmd_w in
        [A-Za-z]:*)
          __wolfcmd_mount_win+=("${__wolfcmd_w//\\040/ }")
          __wolfcmd_mount_posix+=("${__wolfcmd_p//\\040/ }")
          ;;
      esac
    done </proc/mounts
    unset __wolfcmd_w __wolfcmd_p __wolfcmd_rest
  fi

  # $PWD as a Windows path, by the longest matching mount.
  __wolfcmd_windows_dir() {
    local dir=$PWD best=-1 i p
    if [ -n "$__wolfcmd_wsl" ]; then
      if [[ $dir == /mnt/[a-zA-Z] || $dir == /mnt/[a-zA-Z]/* ]]; then
        p=${dir:5:1}
        __wolfcmd_dir="${p^^}:${dir:6}"
        [[ $__wolfcmd_dir == [A-Z]: ]] && __wolfcmd_dir+=/
      else
        __wolfcmd_dir=$dir
      fi
      return
    fi
    for i in "${!__wolfcmd_mount_posix[@]}"; do
      p=${__wolfcmd_mount_posix[$i]}
      if [[ $dir == "$p" || $p == / || $dir == "$p"/* ]] && ((${#p} > best)); then
        best=${#p}
        __wolfcmd_dir="${__wolfcmd_mount_win[$i]%/}"
        if [[ $p != / ]]; then
          __wolfcmd_dir+="${dir#"$p"}"
        else
          __wolfcmd_dir+="$dir"
        fi
      fi
    done
    ((best >= 0)) || __wolfcmd_dir=$dir
    # A drive root ("C:") needs its slash.
    [[ $__wolfcmd_dir == [A-Za-z]: ]] && __wolfcmd_dir+=/
  }

  __wolfcmd_before() {
    local code=$?
    if [ "$__wolfcmd_prompts" -gt 0 ]; then
      printf '\e]133;D;%s\a' "$code"
    fi
    __wolfcmd_prompts=$((__wolfcmd_prompts + 1))
    __wolfcmd_windows_dir
    local dir=$__wolfcmd_dir
    dir=${dir//%/%25}
    dir=${dir// /%20}
    # A Linux path already starts with its slash; a Windows path (C:/x) needs one.
    local sep=/
    [[ $dir == /* ]] && sep=
    printf '\e]7;file://%s%s%s\a' "${HOSTNAME:-localhost}" "$sep" "$dir"
    return $code
  }

  __wolfcmd_after() {
    local code=$?
    # Prompt tools (Starship, Oh My Posh) rebuild PS1 on every prompt: wrap it each time.
    if [[ $PS1 != *'133;A'* ]]; then
      PS1="\[\e]133;A\a\]$PS1\[\e]133;B\a\]"
    fi
    return $code
  }

  # Ours run first (to see the command's $?) and last (to wrap the final PS1).
  __wolfcmd_user=$PROMPT_COMMAND
  while [[ $__wolfcmd_user == *[\;\ ] ]]; do __wolfcmd_user=${__wolfcmd_user%?}; done
  PROMPT_COMMAND="__wolfcmd_before${__wolfcmd_user:+; $__wolfcmd_user}; __wolfcmd_after"
  unset __wolfcmd_user
  PS0="${PS0}"$'\e]133;C\a'
fi
