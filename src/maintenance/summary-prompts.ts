/**
 * The prompts the summary model is given, and the version recorded beside every
 * generated text. A version is stored with the result, so a stored summary says which
 * instruction produced it; bumping one is the only way to say "older answers were made
 * under a different instruction". Nothing here is renamed or reworded by a caller.
 */

/** Prompt version recorded with every stored record summary. */
export const SUMMARY_PROMPT_VERSION = "v1";

/**
 * Record-summary prompt: the model is given the prepared input of one request and must
 * answer with stage segments numbered by the message ranges they cover. The shape this
 * instruction asks for is what `parseSummaryPayload` refuses anything else than.
 */
export const SUMMARY_INSTRUCTION =
  "请将输入按连续编号区间归纳为阶段摘要，不要逐条复述。严格输出 JSON：{title,overview,segments:[{range,summary,key_points,evidence}],decisions,issues}。每个 segment 的 range 使用如 1-6、7-12 的连续区间，evidence 填引用的消息编号。";

/** Prompt version recorded with every generated task brief; bump when the instruction changes. */
export const TASK_BRIEF_PROMPT_VERSION = "v2";

/**
 * Task-brief prompt: the model sees the newest complete request of the task
 * (a multi-turn conversation with tool calls) plus the client identifying
 * headers, and must answer with a short paragraph describing what the task is
 * working on together with the base environment facts it can actually read
 * (which agent, working directory, branch, ...) - not a per-message replay.
 */
export const TASK_BRIEF_INSTRUCTION =
  "下面是一次任务中最新一次请求的完整输入（可能是多轮对话、工具调用与历史），其中 client 是客户端请求头里的标识信息。" +
  "先用一到两段简短的中文话概括这个任务主要在做什么：想完成什么目标、大致是怎样推进的；不要逐条复述消息，也不要罗列工具调用细节，总共不超过 150 字。" +
  "再从输入里读出这次任务的基础环境信息，能读到多少写多少：agent（发起任务的客户端或助手名称，含版本）、cwd（当前工作目录）、git_branch（当前 git 分支）、os（操作系统与 shell），以及其他确实重要的环境（如远程主机、容器、终端）。" +
  '严格输出 JSON：{"brief":"概述文字","facts":{"agent":"…","cwd":"…","git_branch":"…","os":"…"}}。' +
  "facts 里只写你在输入里确实读到的信息，读不到就省略该字段，不要编造，每个值保持简短。";

/** How many environment facts a brief may carry: the card has room for six. */
export const TASK_BRIEF_FACT_LIMIT = 6;

/** How long one brief value may be, whether the model wrote it or read it back. */
export const TASK_BRIEF_FACT_VALUE_LIMIT = 200;

/** The longest brief paragraph the card can show; longer answers end with an ellipsis. */
export const TASK_BRIEF_TEXT_LIMIT = 4000;
