/**
 * Client half of the session recycle bin.
 *
 * Registers five seats, all through official slots:
 *
 *   `sidebar.workspaces.session.menu.item` (order 480)  the "Batch actions…" row
 *   `sidebar.workspaces.session.menu.item` (order 500)  the "Delete session…" row
 *   `shell.overlay`                                     the delete/batch dialogs
 *   `main` (key `session-recycle-bin`)                  the recycle-bin page
 *   `sidebar.panellist` (id `session-recycle-bin`)      the sidebar icon opening it
 *   `settings.section`                                  the same page inside Settings
 *
 * Nothing touches the DOM outside its own components; styling uses only
 * `--dsw-alias-*` theme tokens, so light/dark and future token renames degrade
 * gracefully. Every operation lives on the Host: this half only POSTs to
 * `/dsh-session-recycle-bin/api` and reflects the answer.
 *
 * The module body is one Module Loader factory; the returned object is the
 * Cordis plugin face, and every side effect lives inside `apply`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-recycle-bin',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // `react-dom` is in the Module Loader's static module table, next to
    // `react`, `react/jsx-runtime` and the primitives. It is needed for one
    // reason only: see `PORTAL_ROOT` below.
    const reactDom = require('react-dom')

    /** Locale namespace owned by this package. */
    const NS = 'session-recycle-bin'

    /** Route the Host half registers. */
    const API_PATH = 'dsh-session-recycle-bin/api'

    /**
     * Panel id. The sidebar's `sidebar.panellist` entry and the `main` slot key
     * must be the same string: the sidebar button calls `selectPanel(id)` and
     * the centre column renders the `main` entry whose key equals that id.
     */
    const PANEL_ID = 'session-recycle-bin'

    /** Menu placement: after every shipped row (pin 100 … session-id 450). */
    const MENU_ORDER_DELETE = 500

    /** The batch row sits directly above Delete, inside the same group. */
    const MENU_ORDER_BATCH = 480

    const zh = {
      'menu.delete': '删除会话…',
      'menu.batch': '批量操作…',
      'delete.title': '删除会话',
      'delete.body': '「{title}」会被移入回收站，并立即从侧栏消失。会话日志会移到 $DSH_HOME/session-recycle-bin，可以在回收站里恢复。',
      'delete.childrenLoading': '正在统计这个会话的子会话…',
      'delete.children': '其中 {count} 个子会话会一并移入回收站（子会话跟随主会话，恢复时也一起回来）。',
      'delete.confirm': '移入回收站',
      'delete.cancel': '取消',
      'delete.busy': '正在移入回收站…',
      'delete.sessionId': '会话 ID',
      'error.session-child': '这是一个子代理会话，不能单独删除。删除它的主会话即可，子会话会跟着一起走。',
      'error.session-open': '这个会话还有正在运行的工作（回合、任务、子代理或定时提醒），暂时不能删除。等它完成后再试。',
      'error.session-unknown': '找不到这个会话，可能已经被删除了。',
      'error.session-invalid': '会话 ID 不合法。',
      'error.bin-unknown': '回收站里没有这个条目。',
      'error.bin-invalid': '回收站条目 ID 不合法。',
      'error.restore-conflict': '恢复目标位置已经有同 ID 的会话目录，没有覆盖。',
      'error.action-invalid': '内部错误：请求的动作无法识别。',
      'error.body-invalid': '内部错误：请求体不是合法 JSON。',
      'error.body-too-large': '内部错误：请求体过大。',
      'error.batch-invalid': '内部错误：批量请求的会话列表不合法（不能为空，且最多 200 个）。',
      'error.forbidden': '宿主拒绝了这次请求（来源不受信任）。',
      'error.internal': '宿主内部错误，详情见 DSH 日志。',
      'error.generic': '操作失败：{reason}',
      'batch.title': '批量操作',
      'batch.hint': '勾选要处理的会话，然后归档（DSH 原生归档，可恢复）或删除（移入回收站，可恢复）。',
      'batch.workspace': '工作区：{title}',
      'batch.ungrouped': '未分组',
      'batch.selectAll': '全选',
      'batch.selected': '已选 {count} 个',
      'batch.close': '关闭',
      'batch.archive': '归档',
      'batch.delete': '删除',
      'batch.empty': '这个范围里暂时没有可以批量处理的会话。',
      'batch.running': '运行中',
      'batch.archived': '已归档',
      'batch.busy': '正在处理…',
      'batch.noSelection': '请先勾选至少一个会话。',
      'batch.confirmDelete': '把选中的 {count} 个会话移入回收站？它们可以从回收站恢复。',
      'batch.confirmChildren': '其中 {count} 个子会话会一并移入回收站，恢复时也一起回来。',
      'batch.confirmTitle': '确认移入回收站',
      'batch.confirmAction': '移入回收站',
      'batch.doneArchived': '已归档 {count} 个会话；它们仍在磁盘上，可在侧栏的「显示已归档」里看到。',
      'batch.doneTrashed': '已把 {count} 个会话移入回收站。',
      'batch.doneTrashedChildren': '已把 {count} 个会话移入回收站，其中 {children} 个子会话一并移入。',
      'batch.partialArchived': '已归档 {ok} 个；{failed} 个仍有运行中的工作，未归档。',
      'batch.partialTrashed': '已移入回收站 {ok} 个；{failed} 个仍有运行中的工作，未删除。',
      'bin.nav': '会话回收站',
      'bin.title': '会话回收站',
      'bin.desc': '删除的会话先放在这里，文件仍在磁盘上；子会话跟随主会话一起进来、一起恢复、一起销毁。只有「彻底删除」才会真正销毁。',
      'bin.childCount': '附 {count} 个子会话',
      'bin.empty': '回收站是空的。',
      'bin.loading': '正在读取…',
      'bin.refresh': '刷新',
      'bin.restore': '恢复',
      'bin.purge': '彻底删除',
      'bin.purgeAll': '清空回收站',
      'bin.clearMenu': '清空回收站…',
      'bin.purgeOneTitle': '确认彻底删除',
      'bin.purgeManyTitle': '确认彻底删除选中的条目',
      'bin.purgeAllTitle': '确认清空回收站',
      'bin.purgeOneBody': '将「{title}」彻底删除。此操作无法恢复，会话日志会被销毁。',
      'bin.purgeManyBody': '将彻底删除选中的 {count} 个条目。此操作无法恢复，被选中的会话日志会被销毁。',
      'bin.purgeAllBody': '将清空回收站，彻底删除其中全部 {count} 个条目。此操作无法恢复。',
      'bin.purgeChildren': '其中 {count} 个子会话的日志会一并销毁。',
      'bin.confirm': '确定',
      'bin.sessionId': '会话 ID',
      'bin.workspace': '目录',
      'bin.selectAll': '全选',
      'bin.selected': '已选 {count} 个',
      'bin.restoreSelected': '恢复',
      'bin.purgeSelected': '彻底删除',
      'bin.emptying': '正在清空回收站…',
      'bin.restored': '已恢复；侧栏可能需要刷新一次页面才显示',
      'bin.restoredMany': '已恢复 {count} 个条目；侧栏可能需要刷新一次页面才显示',
      'bin.purgedMany': '已彻底删除 {count} 个条目',
      'bin.batchPartial': '{ok} 个成功；{failed} 个失败（{reason}）',
      'bin.count': '{count} 个条目',
      'bin.noTitle': '（没有标题）',
    }

    const en = {
      'menu.delete': 'Delete session…',
      'menu.batch': 'Batch actions…',
      'delete.title': 'Delete session',
      'delete.body': '"{title}" moves into the recycle bin and leaves the sidebar immediately. Its log moves to $DSH_HOME/session-recycle-bin and can be restored from the bin.',
      'delete.childrenLoading': 'Counting this session\'s subagent sessions…',
      'delete.children': 'Its {count} subagent session(s) move into the recycle bin with it, and come back with it on restore.',
      'delete.confirm': 'Move to recycle bin',
      'delete.cancel': 'Cancel',
      'delete.busy': 'Moving to the recycle bin…',
      'delete.sessionId': 'Session id',
      'error.session-child': 'This is a subagent session and cannot be deleted on its own. Delete its parent session instead — subagents follow their parent.',
      'error.session-open': 'This session still has running work (a turn, job, subagent, or scheduled reminder); it cannot be deleted until that finishes.',
      'error.session-unknown': 'No such session; it may already be deleted.',
      'error.session-invalid': 'That session id is not valid.',
      'error.bin-unknown': 'No such recycle-bin entry.',
      'error.bin-invalid': 'That recycle-bin entry id is not valid.',
      'error.restore-conflict': 'A session directory with that id already exists at the restore target; nothing was overwritten.',
      'error.action-invalid': 'Internal error: the requested action is not recognised.',
      'error.body-invalid': 'Internal error: the request body is not valid JSON.',
      'error.body-too-large': 'Internal error: the request body is too large.',
      'error.batch-invalid': 'Internal error: the batch session list is not valid (it must not be empty and holds at most 200 ids).',
      'error.forbidden': 'The Host refused this request (untrusted origin).',
      'error.internal': 'Host internal error; see the DSH log for details.',
      'error.generic': 'Failed: {reason}',
      'batch.title': 'Batch actions',
      'batch.hint': 'Tick the sessions to handle, then archive them (DSH\'s own archive, restorable) or delete them (into the recycle bin, restorable).',
      'batch.workspace': 'Workspace: {title}',
      'batch.ungrouped': 'Ungrouped',
      'batch.selectAll': 'Select all',
      'batch.selected': '{count} selected',
      'batch.close': 'Close',
      'batch.archive': 'Archive',
      'batch.delete': 'Delete',
      'batch.empty': 'Nothing in this scope can be handled in a batch right now.',
      'batch.running': 'Running',
      'batch.archived': 'Archived',
      'batch.busy': 'Working…',
      'batch.noSelection': 'Tick at least one session first.',
      'batch.confirmDelete': 'Move the {count} selected sessions into the recycle bin? They can be restored from it.',
      'batch.confirmChildren': 'Their {count} subagent session(s) move with them and come back on restore.',
      'batch.confirmTitle': 'Confirm moving to the recycle bin',
      'batch.confirmAction': 'Move to recycle bin',
      'batch.doneArchived': 'Archived {count} session(s); they stay on disk and appear under "show archived" in the sidebar.',
      'batch.doneTrashed': 'Moved {count} session(s) into the recycle bin.',
      'batch.doneTrashedChildren': 'Moved {count} session(s) into the recycle bin, with {children} subagent session(s) in the same entries.',
      'batch.partialArchived': 'Archived {ok}; {failed} still have running work and were left alone.',
      'batch.partialTrashed': 'Moved {ok} into the recycle bin; {failed} still have running work and were not deleted.',
      'bin.nav': 'Session Recycle Bin',
      'bin.title': 'Session Recycle Bin',
      'bin.desc': 'Deleted sessions wait here and their bytes are still on disk. Subagent sessions follow their parent: they enter, restore and get destroyed together. Only "Delete permanently" destroys anything.',
      'bin.childCount': '{count} subagent session(s)',
      'bin.empty': 'The recycle bin is empty.',
      'bin.loading': 'Loading…',
      'bin.refresh': 'Refresh',
      'bin.restore': 'Restore',
      'bin.purge': 'Delete permanently',
      'bin.purgeAll': 'Empty the bin',
      'bin.clearMenu': 'Empty the bin…',
      'bin.purgeOneTitle': 'Confirm permanent deletion',
      'bin.purgeManyTitle': 'Confirm deleting the selected entries',
      'bin.purgeAllTitle': 'Confirm emptying the bin',
      'bin.purgeOneBody': 'This permanently deletes "{title}". It cannot be undone; the session log is destroyed.',
      'bin.purgeManyBody': 'This permanently deletes the {count} selected entries. It cannot be undone; the selected session logs are destroyed.',
      'bin.purgeAllBody': 'This empties the recycle bin, permanently deleting all {count} entries. It cannot be undone.',
      'bin.purgeChildren': 'The logs of their {count} subagent session(s) are destroyed too.',
      'bin.confirm': 'Confirm',
      'bin.sessionId': 'Session id',
      'bin.workspace': 'Directory',
      'bin.selectAll': 'Select all',
      'bin.selected': '{count} selected',
      'bin.restoreSelected': 'Restore',
      'bin.purgeSelected': 'Delete permanently',
      'bin.emptying': 'Emptying the recycle bin…',
      'bin.restored': 'Restored; the sidebar may need one page refresh to show it',
      'bin.restoredMany': 'Restored {count} entries; the sidebar may need one page refresh to show them',
      'bin.purgedMany': 'Permanently deleted {count} entries',
      'bin.batchPartial': '{ok} succeeded; {failed} failed ({reason})',
      'bin.count': '{count} entries',
      'bin.noTitle': '(no title)',
    }

    // ── a tiny external store ───────────────────────────────────────────────
    // The menu rows live in the sidebar slot and the dialogs in the frame-wide
    // overlay slot; they are separate React trees, so a request to open a
    // dialog cannot travel through props or context.

    /** @param {any} initial - starting value. */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set(next) {
          value = next
          for (const listener of [...listeners]) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }
    }

    /** Subscribe a component to one store. */
    function useStore(store) {
      const [, bump] = React.useState(0)
      React.useEffect(() => store.subscribe(() => bump(value => value + 1)), [store])
      return store.get()
    }

    // ── Host calls ──────────────────────────────────────────────────────────

    /**
     * POST one action to the Host half.
     * @param {object} body - `{ action, … }`.
     * @returns {Promise<object>} the Host payload.
     * @throws {Error} carrying `code` and `details` on a business refusal.
     */
    async function callHost(body) {
      const path = new URL(API_PATH, document.baseURI).pathname
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      })
      let payload
      try {
        payload = await response.json()
      }
      catch {
        throw Object.assign(new Error(`HTTP ${response.status}`), { code: response.status === 403 ? 'forbidden' : 'internal' })
      }
      if (payload?.ok !== true) {
        throw Object.assign(new Error(payload?.message ?? `HTTP ${response.status}`), {
          code: typeof payload?.code === 'string' ? payload.code : 'internal',
          details: payload?.details ?? {},
        })
      }
      return payload
    }

    /**
     * Localize a refusal code, falling back to the Host's own message. The
     * locale service returns the key itself for an unknown key, which is how
     * an unmapped code is detected.
     * @param {(key: string, vars?: object) => string} t - bound translator.
     * @param {any} error - the thrown failure.
     * @returns {string} user-facing copy.
     */
    function describeError(t, error) {
      const code = typeof error?.code === 'string' ? error.code : 'internal'
      const key = `error.${code}`
      const localized = t(key)
      if (typeof localized === 'string' && localized !== key) return localized
      return t('error.generic', { reason: error?.message ?? String(error) })
    }

    // ── host-styled pieces ──────────────────────────────────────────────────

    /**
     * The hover fill every shipped clickable row uses.
     *
     * `--dsw-alias-bg-layer-2` is a *surface* token (neutral-bluish 00 in the
     * light palette, i.e. white), so reusing it as a hover fill paints a white
     * block over the sidebar instead of the host's faint grey-blue wash. The
     * menu primitive paints `._item:hover{background:var(--dsw-alias-interactive-bg-hover)}`
     * and the sidebar's `PanelRow` uses the same token, so sharing it is what
     * makes a plugin row look native. The fallback is transparent rather than a
     * surface token: if the token is ever renamed, the row simply stops
     * tinting instead of flashing white.
     */
    const HOVER_FILL = 'var(--dsw-alias-interactive-bg-hover, transparent)'

    /** One button, styled to sit beside the host's own controls. */
    function Button({ children, onClick, variant = 'outline', disabled = false }) {
      const primary = variant === 'primary'
      const danger = variant === 'danger'
      return h('button', {
        type: 'button',
        disabled,
        onClick,
        style: {
          appearance: 'none',
          border: `1px solid ${danger ? 'var(--dsw-alias-state-error-primary)' : primary ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'}`,
          background: primary ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-1)',
          color: danger
            ? 'var(--dsw-alias-state-error-primary)'
            : primary ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-primary)',
          borderRadius: 8,
          padding: '6px 14px',
          fontSize: 13,
          fontWeight: 500,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.55 : 1,
        },
      }, children)
    }

    /** An inline text action, for per-row operations. */
    function LinkButton({ children, onClick, disabled = false, danger = false }) {
      return h('button', {
        type: 'button',
        disabled,
        onClick,
        style: {
          appearance: 'none',
          border: 'none',
          background: 'transparent',
          padding: '2px 6px',
          borderRadius: 6,
          fontSize: 12.5,
          cursor: disabled ? 'default' : 'pointer',
          color: danger ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-brand-primary)',
          opacity: disabled ? 0.55 : 1,
        },
      }, children)
    }

    /**
     * A native checkbox tinted with the brand token. Native input keeps
     * keyboard, focus and screen-reader behaviour the host's own lists rely on.
     */
    function Checkbox({ checked, onChange, disabled = false, label, size = 15 }) {
      return h('input', {
        type: 'checkbox',
        checked,
        disabled,
        'aria-label': label,
        onChange: event => onChange(event.currentTarget.checked),
        style: {
          width: size,
          height: size,
          margin: 0,
          flex: 'none',
          cursor: disabled ? 'default' : 'pointer',
          accentColor: 'var(--dsw-alias-brand-primary)',
        },
      })
    }

    /**
     * Base `z-index` for a portaled dialog.
     *
     * Portaling into `body` removes the `shell.overlay` clamp (see
     * {@link portalTarget}), so the value now competes directly with the host's
     * own `position: fixed` surfaces. The Settings modal is `z-index: 1000`
     * (`ui-settings-general`'s `SettingsRoot_overlay`), and the shipped
     * `Modal`/`Menu` primitives portal into `body` with values in that range
     * too, so a dialog must start above them: a plugin dialog raised from inside
     * Settings has to cover Settings. `layer` then orders plugin dialogs among
     * themselves exactly as before.
     */
    const DIALOG_Z_BASE = 1200

    /**
     * The element every dialog portals into.
     *
     * `shell.overlay` looks frame-wide, but the host wraps it in
     * `.AppFrame_overlayLayer { position: absolute; z-index: 20 }` — a stacking
     * context. Any `zIndex` set *inside* it is clamped under that 20, and the
     * Settings modal (`.SettingsRoot_overlay`, `position: fixed; z-index: 1000`)
     * therefore paints over it. That is exactly the reported bug: opening the
     * bin page inside Settings put the confirmation dialog *behind* the
     * settings panel.
     *
     * React's portal lifts the dialog out of that subtree and into the
     * document body, where it competes at the body level like the host's own
     * modals do. The theme tokens still apply because `ui-theme` declares the
     * palette on `body`, and `body` is where the dialog lands. This is the same
     * mechanism the shipped primitives use for `Modal`/`Menu`/`Tooltip`
     * (`createPortal(..., document.body)`).
     *
     * Falls back to rendering in place when `body` or `createPortal` is
     * unavailable (SSR-ish test hosts), so a missing portal degrades to the
     * old behaviour instead of blanking the slot.
     */
    function portalTarget() {
      return typeof document !== 'undefined' && document.body !== undefined ? document.body : null
    }

    /** Whether this build can portal; read once, it cannot change at runtime. */
    const CAN_PORTAL = typeof reactDom?.createPortal === 'function' && portalTarget() !== null

    /**
     * Render `element` into the document body when possible, in place otherwise.
     * @param {object} element - the React element to place.
     * @returns {object} the element to render from the current slot.
     */
    function portalize(element) {
      return CAN_PORTAL ? reactDom.createPortal(element, portalTarget()) : element
    }

    /**
     * A modal panel: backdrop click and Escape close it, which is the behaviour
     * every host dialog has.
     *
     * The dialog is portaled to `document.body` (see {@link portalTarget}) so it
     * stacks above every host surface — settings included — instead of being
     * trapped under `shell.overlay`'s own stacking context.
     *
     * `closeIcon` adds the host's own corner affordance — a small × in the
     * panel's top-right, with the text kept as the accessible name — for
     * surfaces that should not spend a footer slot on "close".
     *
     * `layer` is the stacking order: a dialog opened *from* another dialog sits
     * on a higher layer. `sealed` marks a dialog that another dialog now covers:
     * it stops taking pointer input, its close paths go inert and assistive
     * technology skips it, so the surface underneath cannot be operated while
     * the confirmation above it is open.
     */
    function Dialog({ title, description, footer, onClose, busy, children, width = 520, closeIcon = false, closeLabel = 'Close', layer = 40, sealed = false }) {
      React.useEffect(() => {
        if (sealed) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape' && !busy) onClose()
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [onClose, busy, sealed])
      return portalize(h('div', {
        'aria-hidden': sealed ? 'true' : undefined,
        style: {
          position: 'fixed',
          inset: 0,
          // Above the host's own modals (`ui-settings` uses 1000) so a dialog
          // raised from inside Settings is not covered by it. Still well under
          // any 32-bit limit, so ordering among plugin dialogs is preserved.
          zIndex: DIALOG_Z_BASE + layer,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent)',
          pointerEvents: sealed ? 'none' : 'auto',
        },
        onMouseDown: (event) => {
          if (sealed) return
          if (event.target === event.currentTarget && !busy) onClose()
        },
      }, h('div', {
        role: 'dialog',
        'aria-modal': sealed ? undefined : 'true',
        'aria-label': title,
        style: {
          position: 'relative',
          width: `min(${width}px, calc(100vw - 48px))`,
          maxHeight: 'calc(100vh - 96px)',
          overflow: 'auto',
          borderRadius: 12,
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-overlay)',
          boxShadow: '0 18px 48px rgba(0, 0, 0, 0.28)',
          color: 'var(--dsw-alias-label-primary)',
          padding: '18px 20px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        },
      },
      closeIcon ? h('button', {
        type: 'button',
        'aria-label': closeLabel,
        title: closeLabel,
        disabled: busy || sealed,
        onClick: onClose,
        style: {
          position: 'absolute',
          top: 10,
          right: 10,
          appearance: 'none',
          border: 'none',
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          width: 26,
          height: 26,
          borderRadius: 6,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          cursor: busy || sealed ? 'default' : 'pointer',
          opacity: busy || sealed ? 0.5 : 1,
        },
        onMouseEnter: (event) => { event.currentTarget.style.background = HOVER_FILL },
        onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
      }, h(CloseGlyph, { size: 14 })) : null,
      h('div', { style: { fontSize: 15, fontWeight: 600, paddingRight: closeIcon ? 24 : 0 } }, title),
      description === undefined ? null : h('div', {
        style: { fontSize: 13, lineHeight: 1.65, color: 'var(--dsw-alias-label-secondary)' },
      }, description),
      children,
      footer === undefined ? null : h('div', {
        style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
      }, footer))))
    }

    /**
     * Render one ISO timestamp in the reader's locale.
     * @param {string|number} value - ISO timestamp or epoch ms.
     * @returns {string} display text.
     */
    function formatStamp(value) {
      const parsed = typeof value === 'number' ? value : Date.parse(String(value))
      return Number.isNaN(parsed) ? String(value) : new Date(parsed).toLocaleString()
    }

    /**
     * The trash glyph used by the sidebar panel button.
     *
     * It paints with `currentColor` only: the sidebar row owns the colour (and
     * its active state), and a literal colour here would ignore the theme.
     * @param {{size?: number}} props - requested square edge in pixels.
     * @returns {object} the SVG element.
     */
    function BinGlyph({ size = 16 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      h('path', { d: 'M2.5 4h11' }),
      h('path', { d: 'M6 4V2.8h4V4' }),
      h('path', { d: 'M4 4l.7 9.2h6.6L12 4' }),
      h('path', { d: 'M6.6 6.6v4.4M9.4 6.6v4.4' }))
    }

    /**
     * The batch glyph: a stack of rows with a check, i.e. "act on several of
     * these at once". It sits in front of the "Batch actions…" menu row, where
     * it has to read clearly at 14px beside the shipped rows' own icons.
     *
     * Painted with `currentColor` only, like {@link BinGlyph}, so the row's
     * colour (error red for Delete, label colour here) drives it.
     * @param {{size?: number}} props - requested square edge in pixels.
     * @returns {object} the SVG element.
     */
    function BatchGlyph({ size = 14 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      // Two stacked rows (the sessions being acted on)…
      h('path', { d: 'M2.5 3.5h8M2.5 7h8M2.5 10.5h4.5' }),
      // …and a check at the end of the last one (the action applied).
      h('path', { d: 'M10.2 10.6l1.6 1.6 2.4-3' }))
    }

    /**
     * A close glyph for surfaces that want an icon instead of a text button.
     * The host's own dialogs put this in the panel's top-right corner.
     * @param {{size?: number}} props - requested square edge in pixels.
     * @returns {object} the SVG element.
     */
    function CloseGlyph({ size = 14 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      h('path', { d: 'M4 4l8 8M12 4l-8 8' }))
    }

    /**
     * A hole-shaped selector hook for the one case where the frame hands a
     * component no store: it keeps the hook call count identical (one call, in
     * a fixed position) so a component still renders instead of throwing.
     * @param {(state: undefined) => any} selector - the caller's projection.
     * @returns {any} the projection of an empty state.
     */
    function emptyStoreHook(selector) {
      return selector(undefined)
    }

    /**
     * Pick the frame-supplied store hook, falling back to the empty one. Both
     * candidates are stable references, so the single hook call below it keeps
     * its position across renders.
     * @param {any} supplied - the standard slot prop, when the frame supplies it.
     * @returns {Function} the hook to call.
     */
    function storeHook(supplied) {
      return typeof supplied === 'function' ? supplied : emptyStoreHook
    }

    // ── the plugin ──────────────────────────────────────────────────────────

    // `sessions` is no longer required: the Client service face has no
    // `refresh()`, and every list change this plugin makes arrives as a Host
    // push (`api-session/removed`) or the Workspace domain stream.
    const inject = ['slots', 'locale']

    /** @param {import('@deepseek-ai/cordis').Context} ctx - client root context. */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-recycle-bin: dictionaries')

      /** Session whose deletion awaits confirmation: `{ sessionId, displayTitle }` or null. */
      const deleteRequest = createStore(null)

      /**
       * Batch scope requested from a session row menu:
       * `{ sessionId, workspaceId, workspaceTitle }` or null. Only the scope is
       * stored; the panel reads the live Workspace and Session snapshots, so a
       * rename or a new session shows up without reopening it.
       */
      const batchRequest = createStore(null)

      /**
       * Where the sidebar entry's context menu was raised (`{ x, y }`) or null.
       * The menu renders from the frame-wide overlay slot: the glyph lives
       * inside the sidebar column, which clips its children, so a popup drawn
       * there would be cut off (and `position: fixed` does not escape an
       * ancestor that owns a transform).
       */
      const binMenuRequest = createStore(null)

      /**
       * The bin's destructive confirmation (the only one: the page's header
       * "empty the bin", the sidebar's right-click "empty the bin", the
       * selection bar's bulk delete and a row's delete all raise this):
       *
       *   `{ kind: 'all' | 'selected' | 'purge', count?, binIds?, binId?, title? }`
       *
       * or null. It is a frame-wide dialog rendered from `shell.overlay`, not a
       * strip inside the page, for two reasons:
       *
       * 1. While it asks, the page underneath must stop taking input. A strip
       *    leaves every checkbox live, so the user could widen the selection
       *    the sentence is asking about — the reported 1.3.0 bug.
       * 2. The request carries the count and the exact entry ids captured when
       *    it was raised, so the confirmation cannot drift onto a different
       *    selection while it is open.
       *
       * `count` is optional: the sidebar raises `{ kind: 'all' }` without
       * knowing the bin size, and the dialog reads it before offering to
       * destroy anything.
       */
      const binConfirmRequest = createStore(null)

      /**
       * Monotonic revision of the bin contents, bumped whenever something
       * changes it outside a given `BinPanel` instance (the right-click
       * "empty the bin" action runs from the overlay, while one or two
       * `BinPanel`s may be mounted). Panels re-read the bin when it changes;
       * their own operations refresh directly, so this only covers changes
       * they did not perform.
       */
      const binRevision = createStore(0)

      /**
       * A one-shot message for the bin panels, raised by an action that ran
       * outside them (currently the sidebar's "empty the bin"). Carries
       * `{ id, text, at }` so the same text raised twice still lands once, and
       * so a panel mounted long after the fact does not surface a stale notice.
       */
      const binFlash = createStore(null)

      /** How long an out-of-panel notice stays worth showing. */
      const FLASH_TTL_MS = 15000

      /**
       * The "Delete session…" row. It renders one `role="menuitem"` button,
       * closes the owning menu through the slot's `useMenuOpenState` hook, and
       * only raises the confirmation — a destructive action never runs from a
       * single click. It is painted with the error token so the destructive row
       * is unmistakable beside the shipped actions.
       */
      function DeleteMenuItem(props) {
        const [, setMenuOpen] = props.useMenuOpenState()
        return h('button', {
          type: 'button',
          role: 'menuitem',
          onClick: () => {
            setMenuOpen(false)
            deleteRequest.set({ sessionId: props.sessionId, displayTitle: props.displayTitle })
          },
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            appearance: 'none',
            border: 'none',
            background: 'transparent',
            color: 'var(--dsw-alias-state-error-primary)',
            padding: '7px 12px',
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 500,
            textAlign: 'left',
            cursor: 'pointer',
          },
          onMouseEnter: (event) => {
            event.currentTarget.style.background = 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)'
          },
          onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
        },
        h('span', { style: { display: 'inline-flex', flex: 'none' } }, h(BinGlyph, { size: 14 })),
        h('span', null, props.t('menu.delete')))
      }

      /**
       * The "Batch actions…" row, directly above Delete.
       *
       * A Workspace's own "…" menu (Rename / Delete Workspace) is private to
       * the shipped browser and is not a slot, so the addable Session row menu
       * is where a per-Workspace batch entry can live without shadowing shipped
       * UI. The row therefore takes its scope from the Session's Workspace.
       */
      function BatchMenuItem(props) {
        const [, setMenuOpen] = props.useMenuOpenState()
        const workspaces = storeHook(props.useWorkspaces)(state => state?.items)
        return h('button', {
          type: 'button',
          role: 'menuitem',
          onClick: () => {
            setMenuOpen(false)
            const owner = (workspaces ?? []).find(workspace => workspace.sessionIds.includes(props.sessionId))
            batchRequest.set({
              sessionId: props.sessionId,
              workspaceId: owner === undefined ? '' : owner.workspaceId,
              workspaceTitle: owner === undefined ? '' : owner.title,
            })
          },
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            appearance: 'none',
            border: 'none',
            borderTop: '1px solid var(--dsw-alias-border-l1)',
            marginTop: 4,
            background: 'transparent',
            color: 'var(--dsw-alias-label-primary)',
            padding: '7px 12px',
            borderRadius: 6,
            fontSize: 13,
            textAlign: 'left',
            cursor: 'pointer',
          },
          onMouseEnter: (event) => { event.currentTarget.style.background = HOVER_FILL },
          onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
        },
        h('span', { style: { display: 'inline-flex', flex: 'none' } }, h(BatchGlyph, { size: 14 })),
        h('span', null, props.t('menu.batch')))
      }

      /** The confirmation dialog, rendered from the frame-wide overlay slot. */
      function DeleteDialog(props) {
        const { t } = props
        const request = useStore(deleteRequest)
        const [busy, setBusy] = React.useState(false)
        const [error, setError] = React.useState(null)
        // How many subagent sessions this delete takes with it. The Host
        // resolves the tree (child sessions never render as sidebar rows, so
        // the Client cannot count them); null while the answer is in flight.
        const [tree, setTree] = React.useState(null)
        const requestedId = request === null ? null : request.sessionId
        React.useEffect(() => {
          if (requestedId === null) {
            setTree(null)
            return undefined
          }
          let cancelled = false
          setTree(null)
          callHost({ action: 'preview', sessionIds: [requestedId] })
            .then((payload) => {
              if (cancelled) return
              const childCount = Number(payload?.childCount ?? 0)
              setTree({ phase: 'ready', childCount: Number.isFinite(childCount) ? childCount : 0 })
            })
            .catch(() => {
              // A failed preview must not block the delete; the dialog simply
              // omits the count and the Host still reports the real result.
              if (!cancelled) setTree({ phase: 'failed', childCount: 0 })
            })
          return () => { cancelled = true }
        }, [requestedId])
        if (request === null) return null
        const childCount = tree?.phase === 'ready' ? tree.childCount : 0
        const description = t('delete.body', { title: request.displayTitle || request.sessionId })
          + (childCount > 0 ? ' ' + t('delete.children', { count: childCount }) : '')
        const close = () => { if (!busy) deleteRequest.set(null) }
        const confirm = () => {
          setBusy(true)
          setError(null)
          callHost({ action: 'trash', sessionId: request.sessionId })
            .then(() => {
              deleteRequest.set(null)
              setBusy(false)
              // No client-side refresh: the Host emits `api-session/removed`,
              // which the session controller turns into a `remove` mutation, so
              // the row drops on its own. (There is no `ctx.sessions.refresh()`
              // in the Client service face — only retain/using/fork/search/
              // projections — so calling one would be a silent no-op.)
            })
            .catch((reason) => {
              setBusy(false)
              setError(describeError(t, reason))
            })
        }
        return h(Dialog, {
          title: t('delete.title'),
          description,
          onClose: close,
          busy,
          footer: [
            h(Button, { key: 'cancel', onClick: close, disabled: busy }, t('delete.cancel')),
            h(Button, { key: 'confirm', onClick: confirm, variant: 'danger', disabled: busy }, busy ? t('delete.busy') : t('delete.confirm')),
          ],
          children: [
            h('div', {
              key: 'id',
              style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' },
            }, `${t('delete.sessionId')}: ${request.sessionId}`),
            tree === null ? h('div', {
              key: 'tree',
              style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
            }, t('delete.childrenLoading')) : null,
            busy ? h('div', { key: 'busy', style: { fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' } }, t('delete.busy')) : null,
            error === null ? null : h('div', {
              key: 'error',
              role: 'alert',
              style: { fontSize: 12.5, color: 'var(--dsw-alias-state-error-primary)', lineHeight: 1.6 },
            }, error),
          ],
        })
      }

      /**
       * The batch panel.
       *
       * Scope: the Workspace the invoking Session belongs to (or the ungrouped
       * bucket). Every row is a real checkbox in this panel's own DOM — the
       * Session row's leading 16px cell is the only place a checkbox could sit
       * inside the shipped row, and it is not rendered at all for a row that has
       * a status dot or is archived, so it cannot carry a complete selection.
       *
       * The two actions are real DSH capabilities rather than plugin lookalikes:
       * Archive calls the Host's `archiveMany`, which runs the registry's own
       * `archiveSession`; Delete calls `trashMany`, which runs the same trashing
       * transaction the single-row menu does. Both are best-effort per session
       * because the Host refuses a session that still has running work, so the
       * panel reports the split instead of hiding it.
       */
      function BatchPanel(props) {
        const { t } = props
        const request = useStore(batchRequest)
        // Every one of these is a standard slot prop the frame supplies to any
        // entry; the fallback keeps the hook-call count fixed if a host build
        // ever omits one, so the component degrades instead of blanking.
        const workspaces = storeHook(props.useWorkspaces)(state => state?.items) ?? []
        const archivedIds = storeHook(props.useWorkspaces)(state => state?.archivedSessionIds) ?? []
        const sessions = storeHook(props.useSessions)(state => state)
        const statuses = storeHook(props.useSessionStatus)(state => state)
        const [selected, setSelected] = React.useState([])
        const [busy, setBusy] = React.useState(false)
        const [notice, setNotice] = React.useState(null)
        const [confirmingDelete, setConfirmingDelete] = React.useState(false)
        const [scopeKey, setScopeKey] = React.useState(null)
        // Total subagent sessions carried by the selection, resolved from the
        // Host when the confirmation opens. Child sessions never render as rows
        // here, so only the Host can count them.
        const [confirmChildren, setConfirmChildren] = React.useState(null)

        // Opening the panel, or moving to another Workspace, starts from no
        // selection: a batch must never inherit a destructive default. This
        // resets during render (the sanctioned "adjust state on prop change"
        // pattern) so a reopen never paints the previous selection first; the
        // panel returns null while closed but stays mounted, so unmount alone
        // would not clear it.
        if (request !== scopeKey) {
          setScopeKey(request)
          setSelected([])
          setNotice(null)
          setConfirmingDelete(false)
        }

        // Resolve the selection's subagent tree when the confirmation opens, so
        // its sentence states how many extra conversations will move.
        React.useEffect(() => {
          if (!confirmingDelete) {
            setConfirmChildren(null)
            return undefined
          }
          let cancelled = false
          setConfirmChildren(null)
          callHost({ action: 'preview', sessionIds: [...selected] })
            .then((payload) => {
              if (cancelled) return
              setConfirmChildren(Number(payload?.childCount ?? 0) || 0)
            })
            .catch(() => {
              // Omit the count rather than block the delete on a failed probe.
              if (!cancelled) setConfirmChildren(0)
            })
          return () => { cancelled = true }
        }, [confirmingDelete])

        const byId = sessions?.byId ?? {}
        const members = (() => {
          if (request === null) return []
          const workspace = request.workspaceId === ''
            ? undefined
            : (workspaces ?? []).find(item => item.workspaceId === request.workspaceId)
          const ids = workspace === undefined
            ? (sessions?.ids ?? []).filter(id => !(workspaces ?? []).some(item => item.sessionIds.includes(id)))
            : workspace.sessionIds
          return ids
            .map(id => byId[id])
            // Match the shipped browser's own visibility: a subagent-origin
            // Session has no row there, and a blank draft is not a conversation
            // yet, so neither belongs in a batch the user picked from that list.
            .filter(summary => summary !== undefined && summary.blank !== true && summary.origin !== 'subagent')
            .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
        })()

        if (request === null) return null

        // `frozen` is true whenever this panel must not react to input: a batch
        // is running, or the delete confirmation is stacked above it. Freezing
        // covers every interactive part at once — checkboxes, select-all, the
        // action buttons and the corner close — because the panel is logically
        // superseded while its own confirmation is open.
        const frozen = busy || confirmingDelete
        const titleOf = summary => {
          const title = typeof summary.title === 'string' ? summary.title.trim() : ''
          return title.length === 0 ? t('bin.noTitle') : title
        }
        const isArchived = summary => (archivedIds ?? []).includes(summary.id)
        const isRunning = summary => statuses?.get?.(summary.id)?.running === true || summary.running === true
        const allSelected = members.length > 0 && selected.length === members.length
        const toggle = (id, next) => {
          if (frozen) return
          setNotice(null)
          setSelected(current => next
            ? (current.includes(id) ? current : [...current, id])
            : current.filter(value => value !== id))
        }
        const close = () => { if (!frozen) batchRequest.set(null) }

        const run = (kind) => {
          // Guard on `busy` only: `frozen` also covers the open confirmation,
          // and this function is exactly what that confirmation calls.
          if (busy) return
          if (selected.length === 0) {
            setNotice(t('batch.noSelection'))
            return
          }
          setBusy(true)
          setNotice(null)
          setConfirmingDelete(false)
          const body = kind === 'archive'
            ? { action: 'archiveMany', sessionIds: [...selected] }
            : { action: 'trashMany', sessionIds: [...selected] }
          callHost(body)
            .then((payload) => {
              setBusy(false)
              setSelected([])
              const ok = kind === 'archive' ? payload.archivedCount : payload.trashedCount
              const failed = payload.failedCount
              const children = Number(payload.childCount ?? 0)
              if (failed === 0) {
                setNotice(kind === 'archive'
                  ? t('batch.doneArchived', { count: ok })
                  : children > 0
                    ? t('batch.doneTrashedChildren', { count: ok, children })
                    : t('batch.doneTrashed', { count: ok }))
              }
              else {
                setNotice(kind === 'archive'
                  ? t('batch.partialArchived', { ok, failed })
                  : t('batch.partialTrashed', { ok, failed }))
              }
              // No client-side refresh is needed or possible here: deleted
              // sessions arrive as Host `api-session/removed` frames, and the
              // archived set arrives through the Workspace domain stream that
              // installs `archivedSessionIds` directly.
            })
            .catch((reason) => {
              setBusy(false)
              setNotice(describeError(t, reason))
            })
        }

        const scopeLabel = request.workspaceTitle === '' || request.workspaceTitle === undefined
          ? t('batch.ungrouped')
          : request.workspaceTitle

        const rows = members.map((summary) => {
          const checked = selected.includes(summary.id)
          const running = isRunning(summary)
          const archived = isArchived(summary)
          return h('label', {
            key: summary.id,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: '6px 8px',
              borderRadius: 8,
              cursor: frozen ? 'default' : 'pointer',
              background: 'transparent',
              fontSize: 13,
              opacity: frozen ? 0.6 : 1,
            },
            onMouseEnter: (event) => {
              if (frozen) return
              event.currentTarget.style.background = HOVER_FILL
            },
            onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
          },
          h(Checkbox, {
            checked,
            disabled: frozen,
            label: titleOf(summary),
            onChange: next => toggle(summary.id, next),
          }),
          h('span', {
            style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, titleOf(summary)),
          running ? h('span', {
            style: { flex: 'none', fontSize: 11.5, color: 'var(--dsw-alias-state-warn-primary)' },
          }, t('batch.running')) : null,
          archived ? h('span', {
            style: { flex: 'none', fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' },
          }, t('batch.archived')) : null,
          h('span', {
            style: { flex: 'none', fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' },
          }, formatStamp(summary.updatedAt ?? '')))
        })

        // Two rows, in this order:
        //   1. the scope line (which Workspace this batch acts on);
        //   2. the selection row (select-all, count) — the user asked for these
        //      to be separate lines so the scope sentence is not squeezed beside
        //      a checkbox.
        // The close affordance is the panel's corner ×, not a footer slot.
        const header = h('div', {
          style: { display: 'flex', flexDirection: 'column', gap: 8 },
        },
        h('div', {
          style: { fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' },
        }, t('batch.workspace', { title: scopeLabel })),
        h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
        },
        h('label', {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            fontSize: 12.5,
            cursor: frozen ? 'default' : 'pointer',
            opacity: frozen ? 0.6 : 1,
          },
        },
        h(Checkbox, {
          checked: allSelected,
          disabled: frozen || members.length === 0,
          label: t('batch.selectAll'),
          onChange: next => {
            if (frozen) return
            setNotice(null)
            setSelected(next ? members.map(summary => summary.id) : [])
          },
        }),
        t('batch.selectAll')),
        h('span', {
          style: { flex: 1, fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' },
        }, t('batch.selected', { count: selected.length }))))

        const body = members.length === 0
          ? h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, t('batch.empty'))
          : h('div', {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              maxHeight: 'min(46vh, 420px)',
              overflow: 'auto',
              border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: 10,
              padding: 6,
              background: 'var(--dsw-alias-bg-layer-1)',
            },
          }, rows)

        const noticeRow = notice === null ? null : h('div', {
          role: 'status',
          style: { fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 },
        }, notice)

        const panel = h(Dialog, {
          title: t('batch.title'),
          description: t('batch.hint'),
          onClose: close,
          busy: frozen,
          width: 640,
          closeIcon: true,
          closeLabel: t('batch.close'),
          // The confirmation is a dialog of its own stacked above this one, so
          // the panel underneath is sealed: it refuses pointer input, its close
          // paths go inert and its controls render disabled.
          sealed: confirmingDelete,
          footer: [
            h(Button, {
              key: 'archive',
              onClick: () => run('archive'),
              disabled: frozen || selected.length === 0,
            }, t('batch.archive')),
            h(Button, {
              key: 'delete',
              variant: 'danger',
              onClick: () => setConfirmingDelete(true),
              disabled: frozen || selected.length === 0,
            }, busy ? t('batch.busy') : t('batch.delete')),
          ],
          children: [header, body, noticeRow],
        })

        if (confirmingDelete === false) return panel

        // The confirmation is its own dialog on a higher layer, not a strip
        // inside the batch panel: it states exactly how many sessions will move
        // (and how many subagent sessions travel with them) and names the action
        // before anything is touched.
        const confirmDescription = t('batch.confirmDelete', { count: selected.length })
          + (Number(confirmChildren) > 0 ? ' ' + t('batch.confirmChildren', { count: confirmChildren }) : '')
        return [
          panel,
          h(Dialog, {
            key: 'batch-confirm',
            title: t('batch.confirmTitle'),
            description: confirmDescription,
            onClose: () => setConfirmingDelete(false),
            busy,
            width: 460,
            layer: 50,
            footer: [
              h(Button, {
                key: 'cancel',
                onClick: () => setConfirmingDelete(false),
                disabled: busy,
              }, t('delete.cancel')),
              h(Button, {
                key: 'confirm',
                variant: 'danger',
                onClick: () => run('trash'),
                disabled: busy,
              }, busy ? t('batch.busy') : t('batch.confirmAction')),
            ],
          }),
        ]
      }

      /**
       * The recycle-bin manager body, rendered by the settings page and the
       * main panel.
       *
       * Layout: one row per entry, each row carrying its own checkbox on the
       * left and its per-entry actions on the right (restore / delete
       * permanently) rather than under the text, so a long list stays compact
       * and the destructive column lines up. Above the list sits the selection
       * bar with the same two actions in bulk; those call the Host's
       * `restoreMany` / `purgeMany`, which run the per-entry path and report an
       * outcome split exactly like the batch delete in the sidebar.
       */
      function BinPanel(props) {
        const { t } = props
        const showTitle = props.showTitle !== false
        const [state, setState] = React.useState({ phase: 'loading', entries: [], error: null })
        const [busy, setBusy] = React.useState(false)
        const [notice, setNotice] = React.useState(null)
        const [selected, setSelected] = React.useState([])
        // Bumped when another surface (the sidebar's right-click "empty the
        // bin", or this page's own confirmation dialog) changes the bin, so
        // this panel re-reads it.
        const revision = useStore(binRevision)
        const flash = useStore(binFlash)
        const confirmRequest = useStore(binConfirmRequest)
        const [seenFlash, setSeenFlash] = React.useState(null)

        const load = React.useCallback(() => {
          setState(current => ({ ...current, phase: 'loading' }))
          callHost({ action: 'list' })
            .then(payload => setState({ phase: 'ready', entries: payload.entries ?? [], error: null }))
            .catch(reason => setState({ phase: 'error', entries: [], error: describeError(t, reason) }))
        }, [t])

        React.useEffect(() => { load() }, [load, revision])

        // A one-shot message from an action that ran outside this panel (the
        // sidebar context menu empties the bin from the overlay slot). Ignored
        // when stale, so opening the bin page later does not replay it.
        React.useEffect(() => {
          if (flash === null || flash.id === seenFlash) return
          setSeenFlash(flash.id)
          if (Date.now() - flash.at > FLASH_TTL_MS) return
          setNotice(flash.text)
        }, [flash, seenFlash])

        // Drop selections whose entries are gone (restored / purged), so the
        // bulk actions can never target a vanished entry.
        React.useEffect(() => {
          setSelected(current => {
            if (current.length === 0) return current
            const live = new Set(state.entries.map(entry => entry.binId))
            const next = current.filter(binId => live.has(binId))
            return next.length === current.length ? current : next
          })
        }, [state.entries])

        /** Restore one entry. The only per-row action that runs without asking. */
        const restoreOne = (binId) => {
          setBusy(true)
          setNotice(null)
          callHost({ action: 'restore', binId })
            .then(() => {
              setBusy(false)
              setNotice(t('bin.restored'))
              load()
              // A restore has no matching push: the Host emits
              // `api-session/removed` in both directions (the only signal the
              // session controller has), and synthesizing `api-session/added`
              // would require a live Session object, which a restored log has
              // only once something activates it. The notice therefore says a
              // page refresh may be needed — see README "已知限制".
            })
            .catch((reason) => {
              setBusy(false)
              setNotice(describeError(t, reason))
            })
        }

        /**
         * Run one bulk action over the current selection. The Host reports the
         * outcome split, so a partially failed bulk action states what happened
         * instead of pretending it either worked or did not.
         *
         * Only restoring is reachable from here; deleting permanently goes
         * through {@link BinConfirmDialog}, which is a dialog of its own.
         * @param {'restoreMany'} action - Host action.
         */
        const runBulk = (action) => {
          const binIds = [...selected]
          if (binIds.length === 0 || busy) return
          setBusy(true)
          setNotice(null)
          callHost({ action, binIds })
            .then((payload) => {
              setBusy(false)
              setSelected([])
              const ok = payload.restoredCount ?? 0
              const failed = payload.failedCount ?? 0
              setNotice(failed === 0
                ? t('bin.restoredMany', { count: ok })
                : t('bin.batchPartial', { ok, failed, reason: describeError(t, payload.failed?.[0] ?? {}) }))
              load()
            })
            .catch((reason) => {
              setBusy(false)
              setNotice(describeError(t, reason))
            })
        }

        const entries = state.entries
        const live = new Set(entries.map(entry => entry.binId))
        const selection = selected.filter(binId => live.has(binId))
        const allSelected = entries.length > 0 && selection.length === entries.length
        /** Subagent sessions one entry carries (schema 1 entries carry none). */
        const childCountOf = entry => Number(entry?.childCount ?? 0)

        // While the confirmation dialog is up, this whole page is frozen: the
        // dialog asks about the selection *as it was raised*, so letting the
        // user keep ticking boxes underneath would make the sentence the dialog
        // is asking about stop being true. (`busy` alone was the 1.3.0 bug.)
        const frozen = busy || confirmRequest !== null
        const toggle = (binId, next) => {
          if (frozen) return
          setNotice(null)
          setSelected(current => next
            ? (current.includes(binId) ? current : [...current, binId])
            : current.filter(value => value !== binId))
        }

        const rows = entries.map(entry => h('div', {
          key: entry.binId,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 10,
            background: 'var(--dsw-alias-bg-layer-1)',
            opacity: frozen ? 0.7 : 1,
          },
        },
        h(Checkbox, {
          checked: selection.includes(entry.binId),
          disabled: frozen,
          label: entry.title || t('bin.noTitle'),
          onChange: next => toggle(entry.binId, next),
        }),
        // The identity block takes the free width; the actions keep their own
        // column on the right so every row's buttons line up.
        h('div', {
          style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
        },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
          h('span', {
            style: { fontSize: 13.5, fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, entry.title || t('bin.noTitle')),
          childCountOf(entry) > 0 ? h('span', {
            style: { flex: 'none', fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' },
          }, t('bin.childCount', { count: childCountOf(entry) })) : null,
          h('span', { style: { flex: 'none', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, formatStamp(entry.deletedAt))),
        h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' } },
          `${t('bin.sessionId')}: ${entry.sessionId}`),
        entry.cwd === undefined ? null : h('div', {
          style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' },
        }, `${t('bin.workspace')}: ${entry.cwd}`)),
        h('div', { style: { flex: 'none', display: 'flex', alignItems: 'center', gap: 6 } },
          h(LinkButton, { onClick: () => restoreOne(entry.binId), disabled: frozen }, t('bin.restore')),
          h(LinkButton, {
            danger: true,
            disabled: frozen,
            onClick: () => binConfirmRequest.set({
              kind: 'purge',
              binId: entry.binId,
              title: entry.title || t('bin.noTitle'),
              childCount: childCountOf(entry),
            }),
          }, t('bin.purge')))))

        const body = state.phase === 'loading' && entries.length === 0
          ? h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, t('bin.loading'))
          : state.phase === 'error'
            ? h('div', { role: 'alert', style: { fontSize: 13, color: 'var(--dsw-alias-state-error-primary)' } }, state.error)
            : entries.length === 0
              ? h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, t('bin.empty'))
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, rows)

        // `showTitle` is false on the main panel, whose own page heading already
        // names the surface: repeating it here would print the name twice. The
        // count and the actions stay either way.
        const header = h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
            showTitle ? h('span', { style: { fontSize: 14, fontWeight: 600 } }, t('bin.title')) : null,
            h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
              t('bin.count', { count: entries.length }))),
          h('div', { style: { display: 'flex', gap: 4 } },
            h(LinkButton, { onClick: load, disabled: frozen }, t('bin.refresh')),
            h(LinkButton, {
              danger: true,
              disabled: frozen || entries.length === 0,
              onClick: () => binConfirmRequest.set({
                kind: 'all',
                count: entries.length,
                childCount: entries.reduce((total, entry) => total + childCountOf(entry), 0),
              }),
            }, t('bin.purgeAll'))))

        // The bulk bar is what makes the checkboxes worth having: select rows,
        // then act on all of them from one place. It is omitted for an empty
        // bin, where there is nothing to select.
        const selectionBar = entries.length === 0 ? null : h('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            padding: '8px 10px',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 10,
            background: 'var(--dsw-alias-bg-layer-1)',
          },
        },
        h('label', {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            fontSize: 12.5,
            cursor: frozen ? 'default' : 'pointer',
            opacity: frozen ? 0.6 : 1,
          },
        },
        h(Checkbox, {
          checked: allSelected,
          disabled: frozen,
          label: t('bin.selectAll'),
          onChange: next => {
            if (frozen) return
            setNotice(null)
            setSelected(next ? entries.map(entry => entry.binId) : [])
          },
        }),
        t('bin.selectAll')),
        h('span', {
          style: { flex: 1, fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' },
        }, t('bin.selected', { count: selection.length })),
        h(Button, {
          onClick: () => runBulk('restoreMany'),
          disabled: frozen || selection.length === 0,
        }, t('bin.restoreSelected')),
        h(Button, {
          variant: 'danger',
          // The count is captured now, so the dialog keeps asking about this
          // selection even if something else changes behind it.
          onClick: () => binConfirmRequest.set({
            kind: 'selected',
            count: selection.length,
            binIds: [...selection],
            childCount: entries
              .filter(entry => selection.includes(entry.binId))
              .reduce((total, entry) => total + childCountOf(entry), 0),
          }),
          disabled: frozen || selection.length === 0,
        }, t('bin.purgeSelected')))

        const noticeRow = notice === null ? null : h('div', {
          role: 'status',
          style: { fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' },
        }, notice)

        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          header,
          h('div', { style: { fontSize: 12.5, lineHeight: 1.65, color: 'var(--dsw-alias-label-secondary)' } }, t('bin.desc')),
          selectionBar,
          body,
          noticeRow)
      }

      /**
       * The sidebar entry's context menu.
       *
       * The sidebar renders only the glyph inside its own row button, and its
       * column clips overflow, so the menu is drawn from the frame-wide overlay
       * slot at the pointer position. The backdrop is transparent and only
       * closes the menu; the item raises the "empty the bin" confirmation,
       * which is a separate dialog so the destructive step always states what
       * it will destroy.
       */
      function BinContextMenu(props) {
        const { t } = props
        const request = useStore(binMenuRequest)
        React.useEffect(() => {
          if (request === null) return undefined
          const onKey = (event) => {
            if (event.key === 'Escape') binMenuRequest.set(null)
          }
          document.addEventListener('keydown', onKey, true)
          return () => document.removeEventListener('keydown', onKey, true)
        }, [request])
        if (request === null) return null
        const width = 184
        const viewportWidth = typeof window.innerWidth === 'number' ? window.innerWidth : 1024
        const viewportHeight = typeof window.innerHeight === 'number' ? window.innerHeight : 768
        const left = Math.max(8, Math.min(request.x ?? 0, viewportWidth - width - 8))
        const top = Math.max(8, Math.min(request.y ?? 0, viewportHeight - 48))
        return portalize(h('div', {
          key: 'bin-menu',
          // Menus sit just under a dialog but still above the host's modals
          // (Settings is 1000), so the entry is never clipped by whatever page
          // is open — the sidebar entry is reachable from inside Settings too.
          style: { position: 'fixed', inset: 0, zIndex: DIALOG_Z_BASE - 10 },
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) binMenuRequest.set(null)
          },
        },
        h('div', {
          role: 'menu',
          'aria-label': t('bin.nav'),
          style: {
            position: 'absolute',
            left,
            top,
            minWidth: width,
            padding: 4,
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 10,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-overlay)',
            boxShadow: '0 18px 48px rgba(0, 0, 0, 0.28)',
          },
        },
        h('button', {
          type: 'button',
          role: 'menuitem',
          onClick: () => {
            binMenuRequest.set(null)
            // The sidebar does not know the bin size; the dialog reads it and
            // states it before offering to destroy anything.
            binConfirmRequest.set({ kind: 'all' })
          },
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            appearance: 'none',
            border: 'none',
            background: 'transparent',
            color: 'var(--dsw-alias-state-error-primary)',
            padding: '7px 10px',
            borderRadius: 6,
            fontSize: 13,
            textAlign: 'left',
            cursor: 'pointer',
          },
          onMouseEnter: (event) => { event.currentTarget.style.background = HOVER_FILL },
          onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
        },
        h('span', { style: { display: 'inline-flex', flex: 'none' } }, h(BinGlyph, { size: 14 })),
        h('span', null, t('bin.clearMenu'))))))
      }

      /**
       * The bin's one destructive confirmation, rendered from the frame-wide
       * overlay slot. It answers every entry point that destroys something.
       *
       * The dialog renders `Dialog`, so Escape, a backdrop click and its own
       * corner close all just cancel; while `busy` they go inert. On confirm it
       * calls the Host and then bumps `binRevision`, the shared signal every
       * mounted bin panel re-reads on — the panel that raised it never runs the
       * purge itself.
       */
      function BinConfirmDialog(props) {
        const { t } = props
        const request = useStore(binConfirmRequest)
        const [busy, setBusy] = React.useState(false)
        const [error, setError] = React.useState(null)
        // The "empty the bin" entry from the sidebar does not know the bin size
        // (nothing loaded it yet), so the dialog reads it. A request that
        // already carries a count — raised from the page, which lists the bin —
        // skips the extra request.
        const [probedCount, setProbedCount] = React.useState(null)
        // Subagent sessions the destroyed entries carry. The page knows them
        // from its listing (each entry reports `childCount`); the sidebar path
        // learns them from the same probe.
        const [probedChildren, setProbedChildren] = React.useState(null)
        const needsProbe = request !== null && request.count === undefined
        React.useEffect(() => {
          if (!needsProbe) return undefined
          let cancelled = false
          setProbedCount(null)
          setProbedChildren(null)
          callHost({ action: 'list' })
            .then((payload) => {
              if (cancelled) return
              const entries = payload.entries ?? []
              setProbedCount(entries.length)
              setProbedChildren(entries.reduce((total, entry) => total + Number(entry.childCount ?? 0), 0))
            })
            .catch(reason => { if (!cancelled) setError(describeError(t, reason)) })
          return () => { cancelled = true }
        }, [needsProbe, t])
        // Reset the transient state whenever a fresh confirmation is raised.
        React.useEffect(() => {
          if (request === null) return
          setBusy(false)
          setError(null)
        }, [request])
        if (request === null) return null

        const count = request.count ?? probedCount
        const known = typeof count === 'number'
        const childCount = typeof request.childCount === 'number' ? request.childCount : (probedChildren ?? 0)
        const close = () => { if (!busy) binConfirmRequest.set(null) }

        const title = request.kind === 'all'
          ? t('bin.purgeAllTitle')
          : request.kind === 'selected' ? t('bin.purgeManyTitle') : t('bin.purgeOneTitle')
        // Every kind names its count: the page passes it (it lists the bin) and
        // the sidebar raises a bare `{ kind: 'all' }` that the probe above
        // completes, so there is no vague "are you sure" fallback to fall into.
        const base = request.kind === 'all'
          ? t('bin.purgeAllBody', { count: known ? count : 0 })
          : request.kind === 'selected'
            ? t('bin.purgeManyBody', { count: request.count ?? 0 })
            : t('bin.purgeOneBody', { title: request.title ?? request.binId })
        const description = base + (childCount > 0 ? ' ' + t('bin.purgeChildren', { count: childCount }) : '')

        const confirm = () => {
          if (busy) return
          setBusy(true)
          setError(null)
          const body = request.kind === 'all'
            ? { action: 'purgeAll' }
            : request.kind === 'selected'
              ? { action: 'purgeMany', binIds: request.binIds ?? [] }
              : { action: 'purge', binId: request.binId }
          callHost(body)
            .then((payload) => {
              setBusy(false)
              const removed = request.kind === 'all'
                ? (payload.purged ?? 0)
                : request.kind === 'selected'
                  ? (payload.purgedCount ?? (payload.purged ?? []).length)
                  : 1
              binFlash.set({
                id: `${Date.now()}-${Math.random()}`,
                text: t('bin.purgedMany', { count: removed }),
                at: Date.now(),
              })
              binRevision.set(binRevision.get() + 1)
              binConfirmRequest.set(null)
            })
            .catch((reason) => {
              setBusy(false)
              setError(describeError(t, reason))
            })
        }

        return h(Dialog, {
          title,
          description,
          onClose: close,
          busy,
          width: 460,
          footer: [
            h(Button, { key: 'cancel', onClick: close, disabled: busy }, t('delete.cancel')),
            h(Button, {
              key: 'confirm',
              variant: 'danger',
              onClick: confirm,
              // An empty bin has nothing to destroy; the sidebar path learns
              // that from the probe, and a disabled confirm says so instead of
              // no-oping.
              disabled: busy || (request.kind === 'all' && known && count === 0),
            }, busy ? t('bin.emptying') : t('bin.confirm')),
          ],
          children: error === null ? undefined : h('div', {
            role: 'alert',
            style: { fontSize: 12.5, color: 'var(--dsw-alias-state-error-primary)', lineHeight: 1.6 },
          }, error),
        })
      }

      /** The settings page; the shell owns its nav row and panel chrome. */
      function BinSettingsSection(props) {
        return h('div', { style: { padding: '4px 2px 24px' } }, h(BinPanel, { t: props.t }))
      }

      /**
       * The recycle-bin page in the centre column, opened from the sidebar
       * panel button. It is an ordinary `main` panel (the same seat Plugins,
       * Schedules and the Plugin Market use), so clicking any Session row in
       * the sidebar returns to the conversation through the shipped browser's
       * own `selectPanel(null)`.
       *
       * Layout copies the shipped management-page pattern (`PluginManagerPage`):
       * a full-height scrolling column, centred content capped at 960px, and a
       * 28px top inset on the heading.
       */
      function BinMainPanel(props) {
        return h('section', {
          'data-plugin-panel': true,
          style: {
            boxSizing: 'border-box',
            height: '100%',
            overflow: 'auto',
            color: 'var(--dsw-alias-label-primary)',
            padding: '0 clamp(24px, 4vw, 48px) 48px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          },
        },
        h('div', {
          style: {
            width: '100%',
            maxWidth: 960,
            boxSizing: 'border-box',
            paddingTop: 28,
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          },
        },
        h('h1', {
          style: { margin: 0, fontSize: 20, fontWeight: 500, lineHeight: '28px' },
        }, props.t('bin.nav')),
        h(BinPanel, { t: props.t, showTitle: false })))
      }

      /**
       * The sidebar panel button's glyph. The host owns the button, its label
       * (announced as aria-label and shown wide), its active state and the
       * click that selects this panel id; an occupant paints the icon only.
       *
       * The right-click menu for this entry lives here too, because the host's
       * `PanelRow` is not a slot: the icon cell is the only piece of that row a
       * plugin renders. The glyph therefore marks itself with
       * `data-session-recycle-bin-nav`, and a document-level `contextmenu`
       * listener (installed for as long as the glyph is mounted) handles a
       * right-click anywhere on the enclosing row button — the label too, not
       * just the 16px cell — without ever touching the host's markup. The
       * request is raised into the overlay slot, because the sidebar column
       * clips its children and a popup drawn here would be cut off.
       */
      function BinNavIcon(owner) {
        React.useEffect(() => {
          const onContextMenu = (event) => {
            const target = event.target
            // `closest`/`querySelector` exist only on a real Element; a
            // synthetic or non-DOM target simply falls through.
            if (target === null || typeof target?.closest !== 'function') return
            const row = target.closest('button')
            if (row === null || row === undefined) return
            if (row.querySelector?.('[data-session-recycle-bin-nav]') === null) return
            event.preventDefault()
            binMenuRequest.set({ x: event.clientX, y: event.clientY })
          }
          document.addEventListener('contextmenu', onContextMenu, true)
          return () => document.removeEventListener('contextmenu', onContextMenu, true)
        }, [])
        return h('span', {
          'data-session-recycle-bin-nav': '1',
          style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
        }, h(BinGlyph, { size: owner?.size ?? 16 }))
      }

      // `locale: NS` is what makes the owner hand every entry its stable `t`;
      // the registration ids are package-namespaced so they never shadow a
      // shipped row.
      ctx.slots.inject('sidebar.workspaces.session.menu.item', function* () {
        yield ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'session-recycle-bin.batch',
          order: MENU_ORDER_BATCH,
          locale: NS,
        }, BatchMenuItem)
        yield ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'session-recycle-bin.delete',
          order: MENU_ORDER_DELETE,
          locale: NS,
        }, DeleteMenuItem)
      })

      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-recycle-bin.overlay',
          locale: NS,
        }, DeleteDialog)
        yield ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-recycle-bin.batch-panel',
          locale: NS,
        }, BatchPanel)
        yield ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-recycle-bin.bin-menu',
          locale: NS,
        }, BinContextMenu)
        yield ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-recycle-bin.bin-confirm',
          locale: NS,
        }, BinConfirmDialog)
      })

      // The `main` entry must be registered while the declaration is live: the
      // sidebar button selects this id, and `layout.selectPanel` refuses an id
      // with no `main` entry.
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, BinMainPanel))

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        label: () => ctx.locale.bind(NS)('bin.nav'),
        locale: NS,
      }, BinNavIcon))

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'session-recycle-bin.bin',
        order: 45,
        label: () => ctx.locale.bind(NS)('bin.nav'),
        locale: NS,
      }, BinSettingsSection))
    }

    return { name: 'session-recycle-bin', inject, apply }
  },
})
