# WolfCmd shell integration for PowerShell 7 and Windows PowerShell 5.1 (N-02).
#
# Passed with -NoExit -EncodedCommand, so it runs after the user's profile (and wraps the
# prompt that profile defined) and is never subject to the execution policy. It wraps the
# existing prompt and PSReadLine; it never replaces them or edits any file.
#
# Reports: OSC 7 (folder), OSC 133;A/B (prompt start/end), 133;C (command start),
# 133;D;<exit code> (command end). Keep this file ASCII: it is sent as UTF-16 base64.

if ($Global:__WolfCmdIntegrated) { return }
$Global:__WolfCmdIntegrated = $true
$Global:__WolfCmdOriginalPrompt = $function:prompt
$Global:__WolfCmdLastHistoryId = -1

function Global:prompt {
    # Read the last command's status before anything here changes it.
    $succeeded = $?
    $exitCode = $Global:LASTEXITCODE
    $esc = [char]27
    $bel = [char]7
    $marks = ''

    $last = Get-History -Count 1
    if ($Global:__WolfCmdLastHistoryId -ge 0) {
        if ($last -and $last.Id -ne $Global:__WolfCmdLastHistoryId) {
            $code = 0
            if (-not $succeeded) {
                $code = 1
                if ($exitCode -is [int] -and $exitCode -ne 0) { $code = $exitCode }
            }
            $marks += "$esc]133;D;$code$bel"
        } else {
            # Empty line: no command ran.
            $marks += "$esc]133;D$bel"
        }
    }
    $Global:__WolfCmdLastHistoryId = 0
    if ($last) { $Global:__WolfCmdLastHistoryId = $last.Id }

    $location = $executionContext.SessionState.Path.CurrentLocation
    if ($location.Provider.Name -eq 'FileSystem' -and $location.ProviderPath -match '^[A-Za-z]:') {
        $path = $location.ProviderPath -replace '\\', '/' -replace '%', '%25' -replace ' ', '%20'
        $marks += "$esc]7;file://$env:COMPUTERNAME/$path$bel"
    }

    $text = ''
    if ($Global:__WolfCmdOriginalPrompt) {
        $text = (& $Global:__WolfCmdOriginalPrompt) -join ''
    } else {
        $text = "PS $($location)$('>' * ($nestedPromptLevel + 1)) "
    }
    $Global:LASTEXITCODE = $exitCode
    "$marks$esc]133;A$bel$text$esc]133;B$bel"
}

# Command start: right after PSReadLine returns the line the user entered.
if (Get-Command PSConsoleHostReadLine -ErrorAction SilentlyContinue) {
    $Global:__WolfCmdOriginalReadLine = $function:PSConsoleHostReadLine
    function Global:PSConsoleHostReadLine {
        $line = & $Global:__WolfCmdOriginalReadLine
        [Console]::Write("$([char]27)]133;C$([char]7)")
        $line
    }
}
