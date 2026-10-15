# WolfCmd shell integration for fish inside WSL (N-02). Mirrors wolfcmd.bash.
#
# Loaded with `fish -l -C "source <this>"`, so it runs after the user's config.fish and wraps
# the prompt that config defined. It never replaces the prompt or edits any file.
#
# Reports: OSC 7 (folder, a Linux path; /mnt/c/x is reported as C:/x), OSC 133;A/B (prompt
# start/end), 133;C (command start), 133;D;<exit code> (command end; plain 133;D after an
# empty line, like the PowerShell script).

if not set -q __wolfcmd_integrated
    set -g __wolfcmd_integrated 1
    set -g __wolfcmd_prompts 0
    set -g __wolfcmd_ran 0
    set -g __wolfcmd_code 0

    # Sets $status for the command after it.
    function __wolfcmd_status
        return $argv[1]
    end

    function __wolfcmd_preexec --on-event fish_preexec
        printf '\e]133;C\a'
    end

    function __wolfcmd_postexec --on-event fish_postexec
        set -g __wolfcmd_code $status
        set -g __wolfcmd_ran 1
    end

    # Before each prompt is drawn: command end, then the folder.
    function __wolfcmd_before --on-event fish_prompt
        if test $__wolfcmd_prompts -gt 0
            if test $__wolfcmd_ran = 1
                printf '\e]133;D;%s\a' $__wolfcmd_code
            else
                printf '\e]133;D\a'
            end
        end
        set -g __wolfcmd_prompts 1
        set -g __wolfcmd_ran 0

        set -l dir $PWD
        if string match -qr '^/mnt/[a-zA-Z](/|$)' -- $dir
            set -l letter (string sub -s 6 -l 1 -- $dir | string upper)
            set -l rest (string sub -s 7 -- $dir)
            test -n "$rest"; or set rest /
            set dir "$letter:$rest"
        end
        set -l sep /
        if string match -q '/*' -- $dir
            set sep ''
        end
        set dir (string replace -a % %25 -- $dir | string replace -a ' ' %20)
        printf '\e]7;file://%s%s%s\a' $hostname "$sep" $dir
    end

    # Prompt start and end around the user's own prompt; their $status is kept.
    if functions -q fish_prompt
        functions -c fish_prompt __wolfcmd_original_prompt
        function fish_prompt
            set -l last $status
            printf '\e]133;A\a'
            __wolfcmd_status $last
            __wolfcmd_original_prompt
            printf '\e]133;B\a'
        end
    end
end
