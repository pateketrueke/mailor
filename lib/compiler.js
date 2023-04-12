const {
  relative, resolve, basename, dirname, join,
} = require('path');

const { existsSync, readFileSync, writeFileSync } = require('fs');
const { exec } = require('child_process');
const { Readable } = require('stream');

const CACHED_DEPS = {};

const RE_STYLE_SRC = /\ssrc=['"](.+?)['"]/;
const RE_MATCH_TAGS = /<[A-Z]\w*[^<>]*>/;
const RE_MATCH_OPEN_TAGS = /<([A-Z]\w*)([^<>]*)>/g;
const RE_MATCH_CLOSE_TAGS = /<\/([A-Z]\w*)>/g;

function fixedAttributes(text) {
  return text.replace(' class=', ' css-class=');
}

function fixedTemplate(text) {
  return text.replace(/^(\s+)(\{[{%].+?[%}]\})\s*$/gm, '$1<mj-raw>$2</mj-raw>');
}

function renderLess(filepath) {
  const source = readFileSync(filepath).toString();

  /* istanbul ignore else */
  if (filepath.indexOf('.less') === -1) {
    return Promise.resolve({
      output: source,
      include: [],
    });
  }

  const options = {
    sync: true,
    syncImport: true,
    filename: filepath,
    plugins: ['less-plugin-autoprefix'],
  };

  return new Promise((_resolve, reject) => {
    require('less').render(source, options, (err, data) => {
      /* istanbul ignore if */
      if (err) {
        reject(err);
        return;
      }

      _resolve({
        output: data.css,
        include: data.imports,
      });
    });
  });
}

function pushCache(filepath, ...dependencies) {
  CACHED_DEPS[filepath] = CACHED_DEPS[filepath] || [];
  CACHED_DEPS[filepath]._entry = true;

  dependencies.forEach(partial => {
    CACHED_DEPS[partial] = CACHED_DEPS[partial] || [];
    CACHED_DEPS[partial]._partial = true;

    /* istanbul ignore else */
    if (CACHED_DEPS[partial].indexOf(filepath) === -1) {
      CACHED_DEPS[partial].push(filepath);
    }

    /* istanbul ignore else */
    if (CACHED_DEPS[filepath].indexOf(partial) === -1) {
      CACHED_DEPS[filepath].push(partial);
    }
  });
}

function replaceTags(text, filepath) {
  while (RE_MATCH_TAGS.test(text)) {
    text = text.replace(RE_MATCH_OPEN_TAGS, (_, tag, attrs) => `<mj-${tag.toLowerCase()}${fixedAttributes(attrs)}>`);
    text = text.replace(RE_MATCH_CLOSE_TAGS, (_, tag) => `</mj-${tag.toLowerCase()}>`);
  }

  return Promise.resolve()
    .then(() => {
      const sources = [];

      text = text.replace(/<mj-style([^<>]*)>/g, (_, attrs) => {
        const key = Math.random().toString(36).substr(2);
        const matches = attrs.match(RE_STYLE_SRC);

        /* istanbul ignore else */
        if (matches) {
          attrs = attrs.replace(matches[0], '');
          sources.push({ key, value: resolve(dirname(filepath), matches[1]) });

          return `<mj-style${attrs}>/*@${key}*/`;
        }
        return _;
      });

      return Promise.all(sources.map(src => renderLess(src.value).then(result => {
        text = text.replace(`/*@${src.key}*/`, result.output);
        pushCache(filepath, src.value, ...result.include);
      }))).then(() => ({ buffer: text, dependencies: sources.map(x => x.value) }));
    });
}

function write(text) {
  const stream = new Readable();

  stream._read = () => {};
  stream.push(text);
  stream.push(null);

  return stream;
}

module.exports = async (templates, {
  cwd, destDir, types, locals, extname,
}) => {
  process.stdout.write(`\rProcessing ${templates.length} file${templates.length === 1 ? '' : 's'}...\x1b[K\n`);

  const sources = templates.reduce((prev, cur) => {
    /* istanbul ignore else */
    if (CACHED_DEPS[cur] && !existsSync(cur)) {
      delete CACHED_DEPS[cur];
    }

    /* istanbul ignore else */
    if (CACHED_DEPS[cur] && !CACHED_DEPS[cur]._entry) {
      CACHED_DEPS[cur].forEach(sub => {
        /* istanbul ignore else */
        if (!prev.includes(sub) && (!CACHED_DEPS[sub] || CACHED_DEPS[sub]._entry)) {
          if (!existsSync(sub)) {
            delete CACHED_DEPS[sub];
          } else {
            prev.push(sub);
          }
        }
      });
      return prev;
    }

    /* istanbul ignore else */
    if (cur.includes('.pug')
      && basename(cur).charAt() !== '_'
      && dirname(cur).charAt() !== '_'
      && !prev.includes(cur)
    ) prev.push(cur);

    return prev;
  }, []);

  const typedefs = [];

  await Promise.all(sources.map(x => {
    // use multiple workers to enable concurrency, prior this change using Promise.all()
    // was not an option, and using a reduce() chain tunred it inneficient...
    return new Promise((_resolve, reject) => {
      process.stdout.write(`\r\x1b[K${relative(cwd, x)}`);

      const content = fixedTemplate(readFileSync(x).toString());

      const tpl = require('pug').compile(content, {
        filename: x,
        pretty: true,
        cache: false,
      });

      return Promise.resolve()
        .then(() => replaceTags(tpl(locals), x))
        .then(({ buffer, dependencies }) => {
          pushCache(x, ...tpl.dependencies, ...dependencies);
          const destFile = join(destDir, `${basename(x, '.pug')}.${extname}`);

          const child = exec(`node "${join(__dirname, 'worker.js')}" "${relative(cwd, x)}" "${destFile}"`, err => {
            if (err) {
              reject(err);
            } else {
              typedefs.push(basename(x, '.pug'));
              _resolve();
            }
          });

          child.stdout.pipe(process.stdout);

          write(buffer).pipe(child.stdin);
        });
    });
  }));

  if (types) {
    const mod = types === true ? 'mailor' : types;

    let buffer = '';
    typedefs.forEach(ref => {
      buffer += `\n  ${ref.replace(/-([a-z])/g, (_, $1) => $1.toUpperCase())}: typeof MailorTemplate;`;
    });
    buffer = `export default interface Templates {${buffer}\n}\n`;
    buffer = `import type { MailorTemplate } from '${mod}';\n${buffer}`;

    writeFileSync(join(destDir, 'index.d.ts'), buffer);
    process.stdout.write(`\r\x1b[K${relative(cwd, destDir)}/index.d.ts\n`);
  }
  process.stdout.write(`\r\x1b[KDone, ${sources.length} template${sources.length === 1 ? '' : 's'} rendered.\n`);
};
