# WolfCmd shell integration for zsh inside WSL (N-02). Mirrors wolfcmd.bash.
#
# Sourced at the end of the user's .zshrc by the ZDOTDIR shims WolfCmd writes next to this
# file (zsh/.zshenv, .zprofile, .zshrc), which read the user's own files first. It wraps the
# user's prompt; it never replaces the prompt or edits any file.
#
# Reports: OSC 7 (folder, a Linux path; /mnt/c/x is reported as C:/x), OSC 133;A/B (prompt
# start/end), 133;C (command start, preexec), 133;D;<exit code> (command end). No subshells
# per prompt.

if [[ -z $__wolfcmd_integrated ]]; then
  typeset -g __wolfcmd_integrated=1
  typeset -gi __wolfcmd_prompts=0

  # Runs first in precmd, so $? is still the command's exit code.
  __wolfcmd_before() {
    local code=$?
    if (( __wolfcmd_prompts > 0 )); then
      printf '\e]133;D;%s\a' "$code"
    fi
    __wolfcmd_prompts=$(( __wolfcmd_prompts + 1 ))
    local dir=$PWD sep=/
    if [[ $dir == /mnt/[a-zA-Z] || $dir == /mnt/[a-zA-Z]/* ]]; then
      local letter=${dir[6]} rest=${dir[7,-1]}
      dir="${(U)letter}:${rest:-/}"
    fi
    [[ $dir == /* ]] && sep=
    dir=${dir//\%/%25}
    dir=${dir// /%20}
    printf '\e]7;file://%s%s%s\a' "${HOST:-localhost}" "$sep" "$dir"
  }

  # Runs last in precmd. Prompt tools (Starship, Oh My Posh) rebuild PS1 on every prompt:
  # wrap it each time. %{ %} tells zsh the escape sequences take no room.
  __wolfcmd_after() {
    if [[ $PS1 != *'133;A'* ]]; then
      PS1=$'%{\e]133;A\a%}'"$PS1"$'%{\e]133;B\a%}'
    fi
  }

  __wolfcmd_preexec() {
    printf '\e]133;C\a'
  }

  precmd_functions=(__wolfcmd_before $precmd_functions __wolfcmd_after)
  preexec_functions+=(__wolfcmd_preexec)
fi
