/* filesUI - the left-hand folder tree.
 *
 * Written as a reusable component rather than a singleton because the
 * copy/move dialogs mount a second instance as their destination picker -
 * that keeps one tree implementation instead of the built-in File
 * Manager's split between its own tree and jquery.filetree.js.
 *
 * Children load lazily on expand. The backend reports, per child, whether
 * it has subdirectories of its own, so an expand arrow is only drawn where
 * expanding would actually do something - no probing round trip, and no
 * arrows that open onto nothing.
 */

window.filesUI = window.filesUI || {};

(function (app) {
  'use strict';

  function Tree(container, options) {
    this.container = container;
    // Marks the container as a tree view so the stylesheet can target it
    // wherever it is mounted. The left pane and the copy/move dialog's
    // destination picker are different elements with different layout
    // classes, so styling keyed off the pane's own class would leave the
    // picker unstyled (it did - the picker rendered with list bullets).
    container.classList.add('filesUI-treeview');
    this.options   = options || {};
    this.onSelect  = this.options.onSelect || function () {};
    this.selected  = null;
    // path -> { li, ul, row, arrow, open, loaded }
    this.nodes = {};
  }

  Tree.prototype.load = function () {
    var self = this;
    return app.roots().then(function (data) {
      self.container.innerHTML = '';
      var list = document.createElement('ul');
      self.container.appendChild(list);
      data.roots.forEach(function (root) {
        list.appendChild(self.buildNode({
          name: root.name,
          path: root.path,
          kids: root.kids,
          icon: root.icon
        }, 0, true));
      });
      return data.roots;
    }).catch(function (err) {
      self.container.innerHTML = '<div class="filesUI-tree-loading">'
        + app.escapeHtml(err.message) + '</div>';
      throw err;
    });
  };

  Tree.prototype.buildNode = function (item, depth, isRoot) {
    var self = this;

    var li = document.createElement('li');
    if (isRoot) li.className = 'filesUI-tree-root';

    var row = document.createElement('div');
    row.className = 'filesUI-tree-row';
    // Indent via padding on the full-width row so hover/selection
    // highlighting still spans the whole pane at depth.
    row.style.paddingLeft = (8 + depth * 14) + 'px';
    row.title = item.path;

    var arrow = document.createElement('i');
    arrow.className = 'fa fa-caret-right filesUI-tree-arrow' + (item.kids ? '' : ' empty');

    var icon = document.createElement('i');
    icon.className = 'fa fa-' + (item.icon || 'folder-o') + ' filesUI-tree-icon';

    var label = document.createElement('span');
    label.className = 'filesUI-tree-label';
    label.textContent = item.name;

    row.appendChild(arrow);
    row.appendChild(icon);
    row.appendChild(label);
    li.appendChild(row);

    var ul = document.createElement('ul');
    ul.hidden = true;
    li.appendChild(ul);

    var node = { li: li, ul: ul, row: row, arrow: arrow, depth: depth, open: false, loaded: false, kids: item.kids };
    this.nodes[item.path] = node;

    // The arrow toggles expansion only; clicking the row navigates. Two
    // separate targets means expanding a huge folder never forces a
    // listing of it, and vice versa.
    arrow.addEventListener('click', function (e) {
      e.stopPropagation();
      self.toggle(item.path);
    });
    row.addEventListener('click', function () {
      self.select(item.path);
      self.onSelect(item.path);
      // Navigating into a collapsed folder opens it, which is what people
      // expect from a tree pane; already-open nodes are left alone so the
      // click doesn't collapse what you just navigated into.
      if (item.kids && !node.open) self.expand(item.path);
    });

    return li;
  };

  Tree.prototype.toggle = function (path) {
    var node = this.nodes[path];
    if (!node || !node.kids) return Promise.resolve();
    return node.open ? this.collapse(path) : this.expand(path);
  };

  Tree.prototype.expand = function (path) {
    var self = this;
    var node = this.nodes[path];
    if (!node || !node.kids) return Promise.resolve();

    node.open = true;
    node.arrow.classList.add('open');
    node.ul.hidden = false;

    if (node.loaded) return Promise.resolve();

    // Spinner rather than silence: an unspun-up array disk can take
    // several seconds to answer the first listing.
    node.arrow.className = 'fa fa-spinner fa-spin filesUI-tree-arrow';

    return app.tree(path).then(function (data) {
      node.arrow.className = 'fa fa-caret-right filesUI-tree-arrow open';
      node.ul.innerHTML = '';
      data.dirs.forEach(function (dir) {
        node.ul.appendChild(self.buildNode(dir, node.depth + 1, false));
      });
      if (!data.dirs.length) {
        // The parent claimed children but has none we can show (all
        // hidden, or they vanished) - drop the arrow so it isn't a trap.
        node.kids = false;
        node.arrow.className = 'fa fa-caret-right filesUI-tree-arrow empty';
      }
      node.loaded = true;
    }).catch(function (err) {
      node.arrow.className = 'fa fa-caret-right filesUI-tree-arrow';
      node.open = false;
      node.ul.hidden = true;
      if (app.setStatus) app.setStatus('Could not read ' + path + ': ' + err.message);
    });
  };

  Tree.prototype.collapse = function (path) {
    var node = this.nodes[path];
    if (!node) return Promise.resolve();
    node.open = false;
    node.arrow.classList.remove('open');
    node.ul.hidden = true;
    return Promise.resolve();
  };

  Tree.prototype.select = function (path) {
    if (this.selected && this.nodes[this.selected]) {
      this.nodes[this.selected].row.classList.remove('selected');
    }
    this.selected = path;
    var node = this.nodes[path];
    if (node) {
      node.row.classList.add('selected');
      if (node.row.scrollIntoView) {
        node.row.scrollIntoView({ block: 'nearest' });
      }
    }
  };

  /* Expand every ancestor of `path` in order, then select it - used when
   * the right pane navigates somewhere the tree hasn't opened yet (a
   * breadcrumb jump, a double-click, or the initial deep-link restore).
   *
   * Walks ancestors sequentially because each level's children only exist
   * once its parent's request has come back.
   */
  Tree.prototype.reveal = function (path) {
    var self = this;

    // Find the deepest root this path lives under - roots overlap
    // (/mnt/user vs /mnt/disk1), so the longest match is the right one.
    var rootPath = null;
    Object.keys(this.nodes).forEach(function (candidate) {
      if (!self.nodes[candidate].li.classList.contains('filesUI-tree-root')) return;
      if (path === candidate || path.indexOf(candidate + '/') === 0) {
        if (!rootPath || candidate.length > rootPath.length) rootPath = candidate;
      }
    });
    if (!rootPath) return Promise.resolve(false);

    var rest = path.slice(rootPath.length).split('/').filter(Boolean);
    var chain = Promise.resolve();
    var current = rootPath;

    chain = chain.then(function () { return self.expand(rootPath); });
    rest.forEach(function (segment) {
      current = current + '/' + segment;
      var target = current;
      chain = chain.then(function () {
        // A path can point somewhere the tree won't show (a hidden folder,
        // or one removed since). Stop quietly instead of throwing.
        if (!self.nodes[target]) return Promise.reject(new Error('stop'));
        return self.expand(target);
      });
    });

    return chain.then(function () {
      self.select(path);
      return true;
    }).catch(function () {
      // Select the deepest ancestor we did manage to reach, so the tree
      // still shows roughly where the right pane is.
      if (self.nodes[current]) self.select(current);
      return false;
    });
  };

  /* Drop a node's cached children so the next expand re-reads it. Called
   * after an operation that changed the folder's subdirectories. */
  Tree.prototype.invalidate = function (path) {
    var node = this.nodes[path];
    if (!node) return;
    var self = this;
    // Forget descendants too, or stale entries linger in this.nodes and
    // reveal() would match paths that no longer exist.
    Object.keys(this.nodes).forEach(function (candidate) {
      if (candidate.indexOf(path + '/') === 0) delete self.nodes[candidate];
    });
    node.loaded = false;
    node.ul.innerHTML = '';
    if (node.open) this.expand(path);
  };

  app.Tree = Tree;

}(window.filesUI));
