# UI Improvement Ideas

This document captures potential UI improvements for future exploration.

---

## Database Tree Expandability

**Problem:** Users may not realize the database tree can be expanded to show more databases, especially for Fungal BLAST.

### Possible Solutions

#### Option A: Add "Expand All" / "Collapse All" buttons
Add buttons above the tree to quickly expand/collapse everything.

```jsx
// In databases_tree.js renderDatabaseTree()
<button onClick={() => $(tree_id).jstree('open_all')}>Expand All</button>
<button onClick={() => $(tree_id).jstree('close_all')}>Collapse All</button>
```

**Pros:** Simple, familiar pattern, gives user control
**Cons:** Adds UI clutter

#### Option B: Add helper text
Add a hint below the search box explaining how to expand.

```
"Click ▶ arrows to expand categories"
```

**Pros:** Non-intrusive, educational
**Cons:** Takes up space, may be ignored

#### Option C: Auto-expand more nodes
Extend the auto-expansion logic (already exists for some MODs in `databases_tree.js` lines 124-251) to:
- Open all top-level nodes by default
- Expand all nodes for Fungal BLAST specifically

**Pros:** Zero user effort required
**Cons:** May overwhelm users with large trees

#### Option D: CSS styling for expand icons
Add custom CSS to make the expand arrows larger/more colorful.

```css
/* Add to public/css/app.css */
.jstree-icon.jstree-ocl {
  font-size: 1.2em;
  color: #f47c20; /* seqorange */
}

/* Or add a pulsing animation for collapsed nodes with children */
.jstree-closed > .jstree-icon.jstree-ocl {
  animation: pulse 2s ease-in-out 3; /* pulse 3 times then stop */
}
```

**Pros:** Visual attention without changing functionality
**Cons:** May be annoying if overdone

#### Option E: Show database count badges
Modify tree node text to show counts.

```
Saccharomyces (12 databases)
```

This would require backend changes to include counts in the tree data structure.

**Pros:** Informative, encourages exploration
**Cons:** Requires backend changes

#### Option F: Start with tree fully expanded
Configure jsTree to initialize with all nodes open.

```javascript
// In databases_tree.js handleLoadTree()
$(tree_id).on('ready.jstree', function() {
    $(tree_id).jstree('open_all');
});
```

**Pros:** Everything visible immediately
**Cons:** May be overwhelming for large database collections

### Recommended Approach
Combination of **Option A** (Expand/Collapse buttons) + **Option B** (helper text) would be the least intrusive and most user-friendly.

---

## BLAST Options Default Selection

**Problem:** The "short-seq" option is selected by default instead of "default" due to hardcoded logic in `options.js`.

### Current Behavior
In `public/js/options.js` (lines 30-35):
```javascript
let selectedOptions = this.props.predefinedOptions.default || {attributes: []};

// Check if there's a 'short-seq' option and use it if available
if (this.props.predefinedOptions['short-seq']) {
    selectedOptions = this.props.predefinedOptions['short-seq'];
}
```

### Possible Solutions

#### Option A: Remove short-seq preference
Simply remove lines 32-35 to let "default" actually be the default.

#### Option B: Add human-readable descriptions
The config already supports a `description` field. Update `sequenceserver.conf`:

```yaml
:blastn:
  :default:
    :attributes:
      - "-task blastn"
      - "-evalue 1e-5"
      - "-max_target_seqs 100"
    :description: "Standard (E-value: 1e-5, Max hits: 100)"
  :short-seq:
    :attributes:
      - "-task blastn-short"
      - "-evalue 1e-1"
    :description: "Short sequences (E-value: 0.1)"
```

#### Option C: Remove short-seq entirely
If not needed, just remove it from the config.

### Recommended Approach
Combination of **Option A** + **Option B**: Fix the JS logic AND add descriptions.

---

## Related Files

- `public/js/databases_tree.js` - Tree rendering and auto-expansion logic
- `public/js/options.js` - BLAST options UI
- `public/configs/sequenceserver.conf` - Server configuration including BLAST options
- `public/css/app.css` - Custom styling
