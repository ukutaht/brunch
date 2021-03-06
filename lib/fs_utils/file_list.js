'use strict';
const debug = require('debug')('brunch:list');
const EventEmitter = require('events').EventEmitter;
const normalize = require('path').normalize;
const fcache = require('fcache');
const deppack = require('deppack'); // isNpmJSON, isNpm
const formatError = require('../helpers').formatError;
const Asset = require('./asset');
const SourceFile = require('./source_file');

const startsWith = (string, substring) => {
  return string.lastIndexOf(substring, 0) === 0;
};

// File list.
// A list of SourceFiles that contains *all* files from Brunches app.

/* A list of `fs_utils.SourceFile` or `fs_utils.Asset`
 * with some additional methods used to simplify file reading / removing.
 */

const defaultInterval = 65;
class FileList extends EventEmitter {
  constructor(config, watcher) {
    super();
    const interval = config.fileListInterval;
    const norm = config._normalized;

    /* Maximum time between changes of two files that will be considered
     * as a one compilation.
     */
    this.resetTime = interval || defaultInterval;

    this.watcher = watcher;
    // Grab values from config.
    this.publicPath = config.paths['public'];
    this.conventions = norm.conventions;
    this.moduleWrapper = norm.modules.wrapper;
    this.configPaths = norm.paths.allConfigFiles;

    this.files = [];
    this.assets = [];
    this.compiling = new Set();
    this.copying = new Set();
    this.compiled = {};
    this.initial = true;

    this.on('change', this._change);
    this.on('unlink', this._unlink);
  }

  getAssetErrors() {
    const invalid = this.assets.filter(a => a.error);
    if (invalid.length > 0) {
      return invalid.map(iv => formatError(iv.error, iv.path));
    } else {
      return null;
    }
  }

  isIgnored(path, test) {
    if (deppack.isNpm(path)) return false;
    if (!test) test = this.conventions.ignored;
    if (this.configPaths.indexOf(path) >= 0) return true;
    switch (toString.call(test).slice(8, -1)) {
      case 'RegExp':
        return path.match(test);
      case 'Function':
        return test(path);
      case 'String':
        return startsWith(normalize(path), normalize(test));
      case 'Array':
        return test.some(subTest => this.isIgnored(path, subTest));
      default:
        return false;
    }
  }

  is(name, path) {
    const convention = this.conventions[name];
    if (!convention) return false;
    if (typeof convention !== 'function') {
      throw new TypeError('Invalid convention ' + convention);
    }
    return convention(path);
  }

  hasFiles() {
    return this.compiling.size > 0 || this.copying.size > 0;
  }

  resetTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.files = this.files.filter(file => !file.disposed);
      if (this.hasFiles()) {
        this.resetTimer();
      } else {
        this.emit('ready');
        this.compiled = {};
      }
    }, this.resetTime);
  }

  find(path) {
    return this.files.find(file => file.path === path);
  }

  findAsset(path) {
    return this.assets.find(file => file.path === path);
  }

  compileDependencyParents(path) {
    const compiled = this.compiled;
    const parents = this.files.filter(dependent => {
      const deps = dependent.dependencies;
      return deps && deps.length > 0 &&
             deps.indexOf(path) >= 0 &&
             !compiled[dependent.path];
    });
    if (!parents.length) return;
    const parentsList = parents.map(p => p.path).join(', ');
    debug(`Compiling dependency ${path} parent(s): ${parentsList}`);
    parents.forEach(this.compile, this);
  }

  compile(file) {
    const path = file.path;
    file.removed = false;
    if (this.compiling.has(path)) {
      this.resetTimer();
    } else {
      const reset = (p) => {
        this.compiling.delete(path);
        this.resetTimer();
        return p;
      };
      this.compiling.add(path);
      file.compile()
          .then(reset, reset)
          .then(() => {
            debug(`Compiled ${path}`);
            this.compiled[path] = true;
            this.emit('compiled', path);
          });
    }
  }

  copy(asset) {
    const path = asset.path;
    const resetCopy = (p) => {
      this.copying.delete(path);
      this.resetTimer();
      return p;
    };

    this.copying.add(path);
    return asset.copy().then(resetCopy, resetCopy);
  }

  _add(path, compiler, linters, isHelper) {
    const isVendor = this.is('vendor', path);
    const wrapper = this.moduleWrapper;
    const file = new SourceFile(
      path, compiler, linters, wrapper, isHelper, isVendor, this
    );
    this.files.push(file);
    return file;
  }

  _addAsset(path) {
    const file = new Asset(path, this.publicPath, this.conventions.assets);
    this.assets.push(file);
    return file;
  }

  _change(path, compiler, linters, isHelper) {
    const ignored = this.isIgnored(path);
    if (this.is('assets', path)) {
      if (!ignored) {
        const file = this.findAsset(path) || this._addAsset(path);
        this.copy(file);
      }
    } else {
      debug(`Reading ${path}`);
      fcache.updateCache(path, error => {
        if (error) throw new Error(formatError('Reading', error));
        // .json files from node_modules should always be compiled
        if (!ignored && (compiler && compiler.length) || deppack.isNpmJSON(path)) {
          const sourceFile = this.find(path) ||
            this._add(path, compiler, linters, isHelper);
          this.compile(sourceFile);
        }
        if (!this.initial) this.compileDependencyParents(path);
        // When the file was ignored.
        this.resetTimer();
      });
    }
  }

  _unlink(path) {
    const ignored = this.isIgnored(path);
    if (this.is('assets', path)) {
      if (!ignored) this.assets.splice(this.assets.indexOf(path), 1);
    } else {
      if (ignored) {
        this.compileDependencyParents(path);
      } else {
        const file = this.find(path);
        if (file && !file.disposed) file.removed = true;
      }
    }
    this.resetTimer();
  }
}

module.exports = FileList;
