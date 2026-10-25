# CI triage: polling and log details

Background for [SKILL.md](./SKILL.md).

## Terminal statuses

A run is finished when `status` is `completed`; `conclusion` then says whether it passed
(`success`), failed (`failure`), or was cancelled/skipped. A queued run reports
`status: queued` or `in_progress` and no conclusion, which is why a loop has to key on
`status` and not on the presence of a conclusion.

## Why the loop exits on the first terminal answer

The first version of this check slept a fixed number of iterations. It kept the session
blocked for minutes after the workflows were already green, and it still gave up before a
slow Windows job finished. Poll on an interval, evaluate every run for the pushed sha,
and return as soon as none of them is queued or in progress.

## Job logs

`/actions/runs/<run_id>/jobs` lists the jobs with their ids. The log endpoint is
`/actions/jobs/<job_id>/logs` and answers with a redirect to a signed URL, so it needs
`curl -L`; without a token it answers 403 for a private repository. The `Authorization`
header is the token `git credential fill` returns for `host=github.com`, which is the
cheapest way to get one without `gh`.

## Machine-specific encoding

Two separate problems, both caused by the GBK default locale:

- Reading: `text=True` in `subprocess` decodes with the locale codec and dies on
  non-ASCII bytes in the JSON body. Read `sys.stdin.buffer.read()` and decode
  `"utf-8"` explicitly.
- Printing: even correctly decoded text dies when it is echoed to a GBK console. Call
  `sys.stdout.reconfigure(encoding="utf-8")` first.

Piping `curl` directly into such a script avoids the intermediate file whose path git-bash
and Windows disagree about (`/tmp` is `C:\Users\hong\AppData\Local\Temp`).
