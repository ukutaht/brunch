'use strict';
const debug = require('debug')('brunch:file');
const smap = require('source-map');
const readFile = require('micro-promisify')(require('fcache').readFile);

const isNpmJSON = require('deppack').isNpmJSON;
const helpers = require('../helpers'); // below

const pipeline = require('./pipeline').pipeline;

const prettify = helpers.prettify;
const identityNode = helpers.identityNode;
const replaceBackSlashes = helpers.replaceBackSlashes;
const isWindows = helpers.isWindows;

const SourceMapConsumer = smap.SourceMapConsumer;
const SourceNode = smap.SourceNode;

// SourceFile: (data) -> File
// Abstraction on top of source file (that's read / compiled.)

const sMapRe = /^\)\]\}'/;

const updateMap = (path, compiled, wrapped, sourceMap) => {
  if (sourceMap) {
    debug("Generated source map for '" + path + "' ");
  }
  let prefix;
  let suffix;
  let wrapperContent;
  if (typeof wrapped === 'object') {
    prefix = wrapped.prefix;
    suffix = wrapped.suffix;
    wrapperContent = wrapped.data || compiled;
  } else {
    const sourcePos = wrapped.indexOf(compiled);
    wrapperContent = sourcePos > 0 ? compiled : wrapped;
    prefix = wrapped.slice(0, sourcePos);
    suffix = wrapped.slice(sourcePos + compiled.length);
  }
  let node;
  if (sourceMap) {
    const mapping = typeof sourceMap === 'string' ?
      JSON.parse(sourceMap.replace(sMapRe, '')) : sourceMap;
    if (isWindows && mapping.sources) {
      mapping.sources = mapping.sources.map(replaceBackSlashes);
    }
    const map = new SourceMapConsumer(mapping);
    node = SourceNode.fromStringWithSourceMap(wrapperContent, map);
  } else {
    node = identityNode(wrapperContent, path);
  }

  node.isIdentity = sourceMap == null;
  if (prefix) node.prepend(prefix);
  if (suffix) node.add(suffix);
  node.source = path;
  node.setSourceContent(path, wrapperContent);

  // the supplied source map might contain more than one source file
  const addSource = path => readFile(path).then(content => {
    node.setSourceContent(path, content.toString());
  });

  const sources = sourceMap && sourceMap.sources || [];
  return Promise.all(sources.map(addSource)).then(() => node);
};

const updateCache = (path, cache, error, result, wrap) => {
  if (error != null) {
    cache.error = error;
    return cache;
  }
  if (result == null) {
    cache.error = null;
    cache.data = null;
    cache.compilationTime = Date.now();
    return cache;
  }
  const source = result.source;
  const compiled = result.compiled;
  const wrapped = wrap(compiled);
  cache.error = null;
  cache.dependencies = result.dependencies;
  cache.source = source;
  cache.compilationTime = Date.now();
  cache.data = compiled;
  updateMap(path, compiled, wrapped, result.sourceMap).then(node => {
    cache.node = node;
    return cache;
  });
};

const makeWrapper = (wrapper, path, isWrapped, isntModule) => {
  return node => {
    return isWrapped ? wrapper(path, node, isntModule) : node;
  };
};

const makeCompiler = (path, cache, linters, compilers, wrap) => {
  const normalizedPath = replaceBackSlashes(path);
  return () => {
    return pipeline(path, linters, compilers, cache.fileList)
      .then(data => {
        return updateCache(normalizedPath, cache, null, data, wrap).then(() => null);
      }, error => {
        return updateCache(normalizedPath, cache, error, null, wrap).then(() => Promise.reject(error));
      });
  };
};


/* A file that will be compiled by brunch. */
class SourceFile {
  constructor(path, compilers, linters, wrapper, isHelper, isVendor, fileList) {
    this.fileList = fileList;
    // treat json files from node_modules as javascript
    const first = compilers && compilers[0];
    const type = first && first.type || isNpmJSON(path) && 'javascript';
    const isntModule = isHelper || isVendor;
    const isWrapped = type === 'javascript' || type === 'template';
    this.path = path;
    this.type = type;
    this.source = '';
    this.data = '';
    this.node = null;
    this.dependencies = [];
    this.compilationTime = null;
    this.error = null;
    this.isHelper = isHelper;
    this.removed = false;
    this.disposed = false;
    const wrap = makeWrapper(wrapper, path, isWrapped, isntModule);
    this.compile = makeCompiler(path, this, linters, compilers, wrap);
    debug(`Init ${path}: %s`, prettify({
      isntModule: isntModule,
      isWrapped: isWrapped
    }));
    Object.seal(this);
  }

  dispose() {
    debug(`Disposing ${this.path}`);
    this.path = '';
    this.data = '';
    this.dependencies = [];
    this.disposed = true;
    this.node = null;
    this.error = null;
    return Object.freeze(this);
  }
}

module.exports = SourceFile;
