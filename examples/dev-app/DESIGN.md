# Design System: Janus

## 1. Visual Theme & Atmosphere

Janus is a framework where applications are graphs of entities — and its UI should feel like that graph made visible. The visual language is dark-mode-native, precise, and structural: a near-black canvas where entity data emerges through careful gradations of luminance. The aesthetic borrows from developer tooling (Linear, Raycast) but carries a warmth appropriate for the real-world applications Janus serves — community associations, operational dashboards, entity management.

The overall impression is one of **quiet density** — information-rich views that never feel cluttered because the hierarchy is managed through opacity, weight, and spacing rather than color variation. Darkness is the native medium. Structure comes from semi-transparent borders and luminance stepping, not visible chrome.

The typography system is built on Inter Variable with OpenType features `"cv01"` and `"ss03"` enabled globally, giving a cleaner, more geometric character. Weight 500 is the workhorse — sitting at true medium, providing emphasis without heaviness. Display sizes use aggressive negative letter-spacing for compressed, authoritative headlines. JetBrains Mono serves as the monospace companion for entity IDs, code, and technical labels.

The color system is achromatic — dark backgrounds with white/gray text — punctuated by a single brand accent: **teal** (`#0d9488` for surfaces, `#2dd4bf` for interactive elements). Teal evokes connection, flow, and data — fitting for a framework built around entity graphs and dispatch pipelines. It's used sparingly: CTAs, active states, entity-type indicators, and status accents.

**Key Characteristics:**
- Dark-mode-native: `#09090b` canvas, `#0f0f12` panel, `#18181b` elevated surface
- Inter Variable with `"cv01", "ss03"` globally
- Weight 500 as the default emphasis weight
- Negative letter-spacing at display sizes (-1.5px at 72px, -1px at 48px)
- Brand teal: `#0d9488` (bg) / `#2dd4bf` (accent) / `#5eead4` (hover)
- Semi-transparent white borders: `rgba(255,255,255,0.06)` to `rgba(255,255,255,0.10)`
- Translucent surfaces: `rgba(255,255,255,0.02)` to `rgba(255,255,255,0.06)`
- Entity-centric component patterns: field renderers, status lifecycles, relation badges

## 2. Color Palette & Roles

### Background Surfaces
- **Canvas** (`#09090b`): The deepest background — the base layer for all pages. Near-black with a cool undertone.
- **Panel** (`#0f0f12`): Sidebar and panel backgrounds. One luminance step above canvas.
- **Surface** (`#18181b`): Elevated areas — cards, dropdowns, popovers.
- **Raised** (`#27272a`): Hover states, secondary surfaces, active rows.

### Text & Content
- **Primary** (`#fafafa`): Near-white for headings and primary content. Not pure white — prevents eye strain.
- **Secondary** (`#d4d4d8`): Cool silver for body text and descriptions.
- **Tertiary** (`#a1a1aa`): Muted gray for metadata, timestamps, field labels.
- **Quaternary** (`#71717a`): Subdued gray for placeholders, disabled states, de-emphasized content.

### Brand & Accent
- **Teal** (`#0d9488`): Primary brand color — CTA backgrounds, entity-type indicators, active navigation.
- **Teal Accent** (`#2dd4bf`): Brighter variant for links, selected states, interactive highlights.
- **Teal Hover** (`#5eead4`): Lighter variant for hover states on accent elements.
- **Teal Muted** (`#115e59`): Subdued teal for subtle background tints, tag backgrounds.

### Status Colors
- **Green** (`#22c55e`): Success, completed lifecycle state, passing tests.
- **Amber** (`#f59e0b`): Warning, in-progress, pending attention.
- **Red** (`#ef4444`): Error, failed, dead-letter, blocked lifecycle state.
- **Blue** (`#3b82f6`): Informational, read operations, neutral status.

### Border & Divider
- **Border Solid** (`#27272a`): Prominent separations between major sections.
- **Border Default** (`rgba(255,255,255,0.10)`): Standard border for cards, inputs, containers.
- **Border Subtle** (`rgba(255,255,255,0.06)`): Ultra-subtle border — structural lines, table dividers.
- **Divider** (`#1c1c1f`): Nearly invisible horizontal/vertical dividers.

### Overlay
- **Backdrop** (`rgba(0,0,0,0.80)`): Modal/dialog overlay — dark for focus isolation.

## 3. Typography Rules

### Font Family
- **Primary**: `Inter Variable`, with fallbacks: `SF Pro Display, -apple-system, system-ui, sans-serif`
- **Monospace**: `JetBrains Mono`, with fallbacks: `ui-monospace, SF Mono, Menlo, monospace`
- **OpenType Features**: `"cv01", "ss03"` enabled globally.

### Hierarchy

| Role | Size | Weight | Line Height | Letter Spacing | Use |
|------|------|--------|-------------|----------------|-----|
| Display XL | 72px | 500 | 1.00 | -1.5px | Hero headlines |
| Display | 48px | 500 | 1.05 | -1.0px | Section headlines |
| Heading 1 | 32px | 500 | 1.15 | -0.7px | Page titles, entity name display |
| Heading 2 | 24px | 500 | 1.30 | -0.3px | Section headings, card titles |
| Heading 3 | 20px | 600 | 1.35 | -0.2px | Feature titles, detail headers |
| Body Large | 18px | 400 | 1.60 | normal | Lead text, feature descriptions |
| Body | 16px | 400 | 1.55 | normal | Standard reading text |
| Body Medium | 16px | 500 | 1.55 | normal | Navigation, labels, emphasized body |
| Small | 14px | 400 | 1.50 | normal | Secondary text, metadata |
| Small Medium | 14px | 500 | 1.50 | normal | Sub-labels, category headers |
| Caption | 13px | 400 | 1.45 | normal | Timestamps, field labels, tertiary info |
| Label | 12px | 500 | 1.40 | 0.02em | Button text, badge labels, small UI |
| Micro | 11px | 500 | 1.35 | 0.03em | Overline text, tiny indicators |
| Mono Body | 14px | 400 | 1.50 | normal | Entity IDs, code, JSON output |
| Mono Caption | 12px | 400 | 1.40 | normal | Field types, handler keys, cron expressions |

### Principles
- **500 is the workhorse**: True medium weight for all emphasis — navigation, labels, headings.
- **Compression at scale**: Display sizes use negative letter-spacing. Below 20px, spacing is normal.
- **Three-tier weight system**: 400 (reading), 500 (emphasis/UI), 600 (strong heading emphasis).
- **Monospace for framework concepts**: Entity IDs, handler keys, operation names, cron expressions, and dispatch paths use JetBrains Mono.

## 4. Component Stylings

### Buttons

**Primary Button**
- Background: `#0d9488`
- Text: `#fafafa`
- Padding: 8px 16px
- Radius: 6px
- Hover background: `#0f766e`
- Use: Primary CTAs, create operations, lifecycle transitions

**Ghost Button**
- Background: `rgba(255,255,255,0.03)`
- Text: `#d4d4d8`
- Padding: 8px 14px
- Radius: 6px
- Border: `1px solid rgba(255,255,255,0.10)`
- Hover background: `rgba(255,255,255,0.06)`
- Use: Secondary actions, cancel, navigation

**Subtle Button**
- Background: `rgba(255,255,255,0.05)`
- Text: `#a1a1aa`
- Padding: 4px 8px
- Radius: 4px
- Use: Toolbar actions, inline actions, compact controls

**Danger Button**
- Background: transparent
- Text: `#ef4444`
- Border: `1px solid rgba(239,68,68,0.30)`
- Padding: 8px 14px
- Radius: 6px
- Hover background: `rgba(239,68,68,0.10)`
- Use: Delete operations, destructive actions

### Cards & Containers

**Entity Card**
- Background: `rgba(255,255,255,0.03)`
- Border: `1px solid rgba(255,255,255,0.08)`
- Radius: 8px
- Padding: 16px
- Hover: background shifts to `rgba(255,255,255,0.05)`
- Use: Entity list items, dashboard tiles

**Detail Panel**
- Background: `#18181b`
- Border: `1px solid rgba(255,255,255,0.06)`
- Radius: 10px
- Padding: 24px
- Use: Entity detail views, form containers

**Section Container**
- Background: transparent
- Border-top: `1px solid rgba(255,255,255,0.06)`
- Padding: 24px 0
- Use: Grouping related fields, section separation within detail views

### Inputs & Forms

**Text Input**
- Background: `rgba(255,255,255,0.03)`
- Text: `#fafafa`
- Placeholder: `#71717a`
- Border: `1px solid rgba(255,255,255,0.10)`
- Padding: 8px 12px
- Radius: 6px
- Focus border: `1px solid #2dd4bf`
- Focus shadow: `0 0 0 2px rgba(45,212,191,0.20)`

**Select / Dropdown**
- Same base as text input
- Dropdown background: `#18181b`
- Dropdown border: `1px solid rgba(255,255,255,0.10)`
- Dropdown radius: 8px
- Option hover: `rgba(255,255,255,0.06)`

### Badges & Status

**Lifecycle Badge**
- Padding: 2px 8px
- Radius: 4px
- Font: 12px weight 500
- Variants by lifecycle state:
  - `pending`: bg `rgba(245,158,11,0.15)`, text `#fbbf24`
  - `in_progress`: bg `rgba(59,130,246,0.15)`, text `#60a5fa`
  - `completed`: bg `rgba(34,197,94,0.15)`, text `#4ade80`
  - `blocked` / `dead`: bg `rgba(239,68,68,0.15)`, text `#f87171`
  - `draft`: bg `rgba(161,161,170,0.15)`, text `#a1a1aa`

**Entity Type Badge**
- Background: `rgba(13,148,136,0.15)`
- Text: `#2dd4bf`
- Padding: 2px 6px
- Radius: 3px
- Font: Mono Caption (12px JetBrains Mono weight 400)
- Use: Inline entity name references, relation targets

**Priority Indicator**
- `high`: `#ef4444` dot
- `medium`: `#f59e0b` dot
- `low`: `#71717a` dot
- Dot size: 6px, border-radius: 50%

### Tables

**Entity Table**
- Header: `#a1a1aa` text, 13px weight 500, uppercase letter-spacing 0.05em
- Header border-bottom: `1px solid rgba(255,255,255,0.08)`
- Row: `#d4d4d8` text, 14px weight 400
- Row border-bottom: `1px solid rgba(255,255,255,0.04)`
- Row hover: background `rgba(255,255,255,0.03)`
- Selected row: background `rgba(13,148,136,0.08)`, left border `2px solid #0d9488`
- Cell padding: 10px 16px

### Navigation

**Sidebar**
- Background: `#0f0f12`
- Width: 240px
- Border-right: `1px solid rgba(255,255,255,0.06)`
- Entity links: 14px weight 500, `#a1a1aa` text, 8px 12px padding, 4px radius
- Active link: `rgba(13,148,136,0.15)` background, `#2dd4bf` text
- Section headers: 11px weight 500, `#71717a` text, uppercase, 0.05em letter-spacing

**Header**
- Background: `#09090b`
- Border-bottom: `1px solid rgba(255,255,255,0.06)`
- Height: 48px
- Title: 14px weight 500, `#fafafa`

## 5. Layout Principles

### Spacing System
- Base unit: 4px
- Scale: 4px, 8px, 12px, 16px, 20px, 24px, 32px, 40px, 48px, 64px, 80px
- Primary rhythm: 8px, 16px, 24px (content spacing)
- Section gaps: 32px–48px
- Page padding: 24px (mobile), 32px–48px (desktop)

### Grid & Container
- Max content width: 1120px
- Sidebar + content layout: 240px fixed sidebar, fluid content area
- Entity list: single column, full-width rows
- Dashboard: 2–3 column card grid, 16px gap
- Detail view: single column, max-width 720px for readability

### Whitespace Philosophy
- **Darkness is whitespace**: The near-black canvas provides natural separation. Explicit dividers are used sparingly.
- **Field grouping through spacing**: Related fields are separated by 12px; field groups by 24px. No visible group borders — spacing communicates hierarchy.
- **Generous vertical rhythm**: Entity detail views use 24px between field groups, 48px between major sections.

### Border Radius Scale
- Micro (3px): Inline badges, entity type tags
- Small (4px): Lifecycle badges, subtle buttons, table cells
- Standard (6px): Buttons, inputs, functional elements
- Card (8px): Entity cards, dropdowns
- Panel (10px): Detail panels, dialog containers
- Large (12px): Modal dialogs, command palette
- Pill (9999px): Status dots, filter chips

## 6. Depth & Elevation

| Level | Treatment | Use |
|-------|-----------|-----|
| Flat | No shadow, `#09090b` bg | Page canvas |
| Surface | `rgba(255,255,255,0.03)` bg, border | Cards, list items |
| Raised | `rgba(255,255,255,0.06)` bg, border | Hover states, active rows |
| Elevated | `0 4px 12px rgba(0,0,0,0.40)` | Dropdowns, popovers |
| Dialog | `0 8px 30px rgba(0,0,0,0.50), 0 0 0 1px rgba(255,255,255,0.08)` | Modals, command palette |
| Focus | `0 0 0 2px rgba(45,212,191,0.20)` + teal border | Keyboard focus ring |

**Elevation through luminance**: On dark surfaces, elevation is communicated by increasing the white opacity of the background — `0.02` → `0.03` → `0.06`. Borders provide the edge definition. Traditional shadows are only used for floating elements (dropdowns, dialogs).

## 7. Do's and Don'ts

### Do
- Use Inter Variable with `"cv01", "ss03"` on all text
- Use weight 500 as the default emphasis weight
- Apply negative letter-spacing at display sizes
- Build on the near-black canvas: `#09090b` base, `#0f0f12` panels, `#18181b` surfaces
- Use semi-transparent white borders (`rgba(255,255,255,0.06–0.10)`)
- Keep surfaces translucent: `rgba(255,255,255,0.03–0.06)`, never solid colors
- Reserve brand teal for interactive elements and entity-type indicators
- Use `#fafafa` for primary text, not pure `#ffffff`
- Use lifecycle badge colors consistently: green=completed, amber=pending, red=blocked, blue=in_progress
- Use JetBrains Mono for all framework concepts: entity names, handler keys, IDs, operations

### Don't
- Don't use pure white (`#ffffff`) as text or background
- Don't use solid colored surfaces — translucency is the system
- Don't apply brand teal decoratively — it's reserved for interaction and entity identity
- Don't use positive letter-spacing on display text
- Don't use weight 700+ — the maximum is 600, with 500 as the default emphasis
- Don't introduce warm accent colors — the palette is cool zinc with teal accent only
- Don't use visible opaque borders on dark backgrounds — borders are semi-transparent white
- Don't mix monospace and proportional fonts for the same type of content
- Don't use color alone to communicate lifecycle state — always pair with text labels

## 8. Responsive Behavior

### Breakpoints
| Name | Width | Key Changes |
|------|-------|-------------|
| Mobile | <640px | Single column, sidebar collapses to hamburger, compact padding |
| Tablet | 640–1024px | Sidebar overlay, 2-column dashboard grid |
| Desktop | 1024–1280px | Fixed sidebar, full layout |
| Large | >1280px | Generous margins, max-width content container |

### Collapsing Strategy
- Sidebar: persistent on desktop, collapsible overlay on tablet/mobile
- Entity tables: horizontal scroll with sticky first column on mobile
- Dashboard cards: 3-col → 2-col → 1-col stack
- Detail views: maintain single-column through all sizes, reduce padding
- Display text: 48px → 32px → 24px with proportional tracking adjustments

### Touch Targets
- Minimum tap target: 44px height for interactive elements
- Table rows: 44px minimum height on mobile
- Buttons: minimum 36px height, 8px padding
- Sidebar links: 36px height, full-width tap area

## 9. Agent Prompt Guide

### Quick Color Reference
- Page background: `#09090b`
- Panel background: `#0f0f12`
- Surface: `#18181b`
- Heading text: `#fafafa`
- Body text: `#d4d4d8`
- Muted text: `#a1a1aa`
- Dim text: `#71717a`
- Brand accent: `#2dd4bf`
- Brand surface: `#0d9488`
- Border default: `rgba(255,255,255,0.10)`
- Border subtle: `rgba(255,255,255,0.06)`
- Focus ring: `0 0 0 2px rgba(45,212,191,0.20)`

### Entity View Patterns

**Entity List Page**
- Sidebar left (240px, `#0f0f12`), content right (`#09090b`)
- Page title at Heading 1 (32px, 500, `#fafafa`), entity count as Caption (`#71717a`)
- Filter bar: ghost buttons with lifecycle badge styling
- Table rows: entity name in Body Medium (`#fafafa`), metadata in Caption (`#a1a1aa`)
- Lifecycle status as colored badge per Section 4
- Row click navigates to detail

**Entity Detail Page**
- Back link in Small Medium, teal accent
- Entity name at Heading 1
- Lifecycle badge beside the name
- Fields grouped in Section Containers
- Field labels in Caption (`#a1a1aa`), values in Body (`#d4d4d8`)
- Relation fields show entity type badge (teal mono) + linked entity name
- Actions bar at top-right: primary button for main action, ghost buttons for secondary

**Dashboard Page**
- 2–3 column card grid
- Each card: entity count, sparkline or status breakdown, entity type badge
- Card click navigates to entity list

### Example Component Prompts
- "Entity list row: `rgba(255,255,255,0.03)` hover bg. Name at 14px Inter weight 500 `#fafafa`. Status lifecycle badge. Priority dot. Timestamp at 13px `#71717a`. Border-bottom `rgba(255,255,255,0.04)`."
- "Detail field group: label at 13px weight 400 `#a1a1aa` with 4px bottom margin. Value at 16px weight 400 `#d4d4d8`. Group spacing 24px. Editable fields get text input with teal focus ring."
- "Lifecycle transition button: `#0d9488` bg, `#fafafa` text, 6px radius. Shows target state name. Disabled states at 40% opacity."

### Iteration Guide
1. Always set `font-feature-settings: "cv01", "ss03"` on all Inter text
2. Letter-spacing: -1.5px at 72px, -1.0px at 48px, -0.7px at 32px, normal below 20px
3. Three weights only: 400, 500, 600. Never 700.
4. Surface elevation via background opacity: `0.02 → 0.03 → 0.06`
5. Teal (`#0d9488` / `#2dd4bf`) is the only chromatic accent
6. All borders are semi-transparent white, never solid dark colors
7. JetBrains Mono for: entity names, handler keys, IDs, operations, cron expressions, field types
8. Lifecycle states always use their canonical colors (green/amber/red/blue/gray)
