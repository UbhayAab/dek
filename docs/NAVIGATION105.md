# Flat server navigation and popup placement

Desktop sidebar and phone Home render one flat list per server. General is an
ordinary channel; category metadata and older category-collapse preferences do
not hide it or any other channel. Text precedes voice, including new additions,
then uses the existing position/name order. Joined, archive, organization and
partial-access filters, server collapse, current-location hints and DM behavior
remain. The internal single category-null group keeps Home consumers compatible.

Members can reach their server settings and the individual delegated actions.
The Admin-only policy editor stays protected. Channel deletion is independent of
editing and does not inherit channel-owner privileges over a native false grant.

The kit Menu portals a fixed-position popup outside sidebar overflow. It clamps
against both axes of the current VisualViewport, flips upward where appropriate,
scrolls long content and recomputes on scroll/resize. A popup invoked within a
native modal stays in that top-layer dialog, outside its clipping panel. Touch
continues to use an action sheet with a viewport-constrained height.

Portal clicks are included in containment checks. Choosing an action closes the
menu before invoking it once, so opening a confirmation dialog retains the right
focus target. Arrows, Home/End, Escape/Tab, disabled entries, outside clicks,
navigation and native Back retain explicit keyboard/focus behavior.

Root authored all changes and actual DOM interaction tests in the existing chat.
Mocked geometry is not physical-browser layout evidence. Styled desktop/phone
checks, normal native/publication/deployment and hosted fictional-fixture
acceptance remain required before closing #105. No data migration or category
deletion is introduced, and no new worker/provider or schedule was used.
