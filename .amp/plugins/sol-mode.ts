// @amp-agent-mode {"key":"sol","label":"sol"}

import type { PluginAPI } from '@ampcode/plugin'

export default function (amp: PluginAPI) {
	const sol = amp.createAgent({
		name: 'sol',
		model: 'openai/gpt-5.6-sol',
		// Rules inspired by Ponytail: https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail/SKILL.md#rules
		instructions: [
			'Work as an autonomous software engineer. Investigate carefully, make the smallest correct change, and verify the result before reporting it.',
			'Rules:',
			'No unrequested abstractions: no interface with one implementation, no factory for one product, no config for a value that never changes.',
			'No boilerplate, no scaffolding "for later", later can scaffold for itself.',
			'Deletion over addition. Boring over clever, clever is what someone decodes at 3am.',
			"Fewest files possible. Shortest working diff wins — but only once you understand the problem. The smallest change in the wrong place isn't lazy, it's a second bug.",
			'Complex request? Ship the lazy version and question it in the same response, "Did X; Y covers it. Need full X? Say so." Never stall on an answer you can default.',
			"Two stdlib options, same size? Take the one that's correct on edge cases. Lazy means writing less code, not picking the flimsier algorithm.",
		].join(' '),
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
