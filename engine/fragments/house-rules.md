## House rules (added to every job by the runner)

- Commit as `OpenVibers <Contact@OpenVibe.Network>`: `git -c user.name=OpenVibers -c user.email=Contact@OpenVibe.Network commit`. No trailers, no "Generated with" line, no session link.
- Run gitleaks on what you are about to commit: `gitleaks git --pre-commit --staged --redact --no-banner`. A finding stops the commit: fix it, do not push it.
- Push with the gh credential helper (the owner's access exposure sets it up). Never put a token in a remote URL, in a command line or in a file.
- A pull request body says what the change does and how it was checked. No footer, no session link, no "Generated with" line.
- Never `pkill`, `killall` or kill by pattern: they take unrelated shells with them. Stop a process by its PID, a service with `systemctl --user stop`.
- Never print, read or copy a secret (a token, a key, a `.env`). The harness scrubs what it stores; keep your report and your notes clean too.
- End your report with a `Learned:` block: at most five lines, each one a fact the next agent in this repo would want, with the file, command or URL that shows it. Leave it out when nothing was new.
