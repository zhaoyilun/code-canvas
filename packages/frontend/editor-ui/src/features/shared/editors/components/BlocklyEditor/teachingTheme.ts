import type { Theme } from 'blockly';

export type TeachingBlocklyAppearance = 'logic' | 'capability';

type BlocklyThemeDefinition = {
	name: string;
	base?: string | Theme;
	blockStyles?: Record<
		string,
		{
			colourPrimary?: string;
			colourSecondary?: string;
			colourTertiary?: string;
			hat?: string;
		}
	>;
	categoryStyles?: Record<string, { colour: string }>;
	componentStyles?: {
		workspaceBackgroundColour?: string;
		toolboxBackgroundColour?: string;
		toolboxForegroundColour?: string;
		flyoutBackgroundColour?: string;
		flyoutForegroundColour?: string;
		flyoutOpacity?: number;
		scrollbarColour?: string;
		scrollbarOpacity?: number;
		insertionMarkerColour?: string;
		insertionMarkerOpacity?: number;
		markerColour?: string;
		cursorColour?: string;
		selectedGlowColour?: string;
		selectedGlowOpacity?: number;
		replacementGlowColour?: string;
		replacementGlowOpacity?: number;
	};
	fontStyle?: {
		family?: string;
		weight?: string;
		size?: number;
	};
	startHats?: boolean;
};

/** The minimal Theme surface used by the dynamically loaded Blockly runtime. */
type BlocklyThemeRuntime = {
	Theme: {
		defineTheme: (name: string, theme: BlocklyThemeDefinition) => Theme;
	};
	Themes: {
		Classic: Theme;
	};
};

/**
 * Keeps Blockly's native renderer while giving each teaching canvas a distinct
 * presentation. Workspace state, block definitions, and compilation remain in
 * their profile adapter rather than this theme boundary.
 */
export function createTeachingBlocklyTheme(
	blockly: BlocklyThemeRuntime,
	appearance: TeachingBlocklyAppearance,
): Theme {
	const isCapabilityPlan = appearance === 'capability';
	const themeName = `n8n-teaching-${appearance}`;
	const palette = isCapabilityPlan
		? {
				primary: '#0f766e',
				primaryLight: '#2dd4bf',
				primaryDark: '#115e59',
				companion: '#b45309',
				companionLight: '#fbbf24',
				companionDark: '#92400e',
				workspace: '#f4fbf8',
			}
		: {
				primary: '#2563eb',
				primaryLight: '#60a5fa',
				primaryDark: '#1d4ed8',
				companion: '#7c3aed',
				companionLight: '#a78bfa',
				companionDark: '#5b21b6',
				workspace: '#f8fbff',
			};

	return blockly.Theme.defineTheme(themeName, {
		name: themeName,
		base: blockly.Themes.Classic,
		componentStyles: {
			workspaceBackgroundColour: palette.workspace,
			toolboxBackgroundColour: '#ffffff',
			toolboxForegroundColour: '#334155',
			flyoutBackgroundColour: '#ffffff',
			flyoutForegroundColour: '#172033',
			flyoutOpacity: 0.98,
			scrollbarColour: palette.primary,
			scrollbarOpacity: 0.45,
			insertionMarkerColour: palette.primary,
			insertionMarkerOpacity: 0.34,
			markerColour: palette.companion,
			cursorColour: palette.primary,
			selectedGlowColour: palette.primaryLight,
			selectedGlowOpacity: 0.42,
			replacementGlowColour: palette.companionLight,
			replacementGlowOpacity: 0.34,
		},
		fontStyle: {
			family: 'InterVariable, "Microsoft YaHei", system-ui, sans-serif',
			weight: '500',
			size: 12,
		},
		blockStyles: {
			logic_blocks: createBlockStyle(
				palette.companion,
				palette.companionLight,
				palette.companionDark,
			),
			loop_blocks: createBlockStyle(palette.primary, palette.primaryLight, palette.primaryDark),
			math_blocks: createBlockStyle('#3b82f6', '#93c5fd', '#1d4ed8'),
			text_blocks: createBlockStyle('#8b5cf6', '#c4b5fd', '#6d28d9'),
			list_blocks: createBlockStyle('#0d9488', '#5eead4', '#0f766e'),
			variable_blocks: createBlockStyle('#d97706', '#fcd34d', '#92400e'),
			procedure_blocks: createBlockStyle(
				palette.primary,
				palette.primaryLight,
				palette.primaryDark,
			),
		},
		categoryStyles: {
			logic_category: { colour: palette.companion },
			loop_category: { colour: palette.primary },
			math_category: { colour: '#3b82f6' },
			text_category: { colour: '#8b5cf6' },
			list_category: { colour: '#0d9488' },
			variable_category: { colour: '#d97706' },
			procedure_category: { colour: palette.primary },
		},
		startHats: false,
	});
}

function createBlockStyle(colourPrimary: string, colourSecondary: string, colourTertiary: string) {
	return {
		colourPrimary,
		colourSecondary,
		colourTertiary,
	};
}
