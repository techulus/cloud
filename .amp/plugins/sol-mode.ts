// @amp-agent-mode {"key":"sol","label":"sol"}

import type { PluginAPI } from '@ampcode/plugin'

export default function (amp: PluginAPI) {
	const sol = amp.createAgent({
		name: 'sol',
		model: 'openai/gpt-5.6-sol',
		instructions:
			'Work as an autonomous software engineer. Investigate carefully, make the smallest correct change, and verify the result before reporting it.',
		tools: 'all',
		reasoningEffort: 'xhigh',
	})

	amp.registerAgentMode({
		key: 'sol',
		label: 'sol',
		description: 'GPT-5.6 Sol with all tools and xhigh reasoning.',
		agent: sol.definition,
	})
}
