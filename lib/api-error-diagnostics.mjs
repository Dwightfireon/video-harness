/* 只输出固定分类，不保存上游 message/code（可能含凭证或原稿）。 */
export function apiErrorCode(error) {
  const text = [error?.code, error?.type, error?.message, error?.error?.code, error?.error?.message]
    .filter(v => typeof v === 'string').map(v => v.slice(0, 16000)).join(' ').toLowerCase();
  if (/content_filter|content_policy|safety_violation|policy_violation/.test(text)) return 'content_policy';
  if (/context_length_exceeded|maximum context length|context window|prompt.{0,30}too long|input.{0,30}token.{0,30}exceed/.test(text)) return 'context_length_exceeded';
  if (/invalid_tool_call|invalid_function_arguments|tool_use_failed|tool.{0,20}arguments.{0,40}(?:invalid|json)|failed to (?:parse|generate) (?:tool|function)/.test(text)) return 'invalid_tool_call';
  if (/invalid_messages|tool_call_id|tool.{0,20}(?:response|result).{0,30}(?:missing|match)/.test(text)) return 'invalid_messages';
  if (/(?:tool_choice|parallel_tool_calls).{0,80}(?:not supported|unsupported|invalid|not allowed)/.test(text)) return 'unsupported_tool_choice';
  if (/max_tokens.{0,60}(?:exceed|limit|unsupported|invalid)|max_completion_tokens/.test(text)) return 'output_token_limit';
  return 'unknown_api_error';
}

export const API_ERROR_LABELS = Object.freeze({
  content_policy: '内容策略拒绝', context_length_exceeded: '模型上下文超限',
  invalid_tool_call: '接口无法生成或解析工具参数', invalid_messages: '接口拒绝消息或工具配对',
  unsupported_tool_choice: '接口不支持定向工具调用',
  output_token_limit: '接口不接受输出额度参数', unknown_api_error: '接口未提供可识别的错误原因',
});
