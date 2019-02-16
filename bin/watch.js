const liveServer = require('live-server');
const chokidar = require('chokidar');

const {
  resolve,
  basename,
} = require('path');

const compiler = require('../lib/compiler');

module.exports = async (templates, opts) => {
  async function run(srcFiles) {
    try {
      await compiler(srcFiles, opts);
    } catch (e) {
      process.stderr.write(`\x1b[31m${e.message}\x1b[0m\n`);
    }
  }

  if (opts.build !== false) {
    await run(templates);
  }

  const ee = chokidar.watch(templates, {
    cwd: opts.cwd,
    ignored: [],
    persistent: true,
    ignoreInitial: true,
    ignorePermissionErrors: true,
    followSymlinks: false,
  });

  let files = [];
  let interval;

  function update() {
    clearTimeout(interval);
    interval = setTimeout(async () => {
      await run(files);
      files = [];
    }, opts.timeout || 200);
  }

  ee.on('all', (evt, file) => {
    if (!files.includes(file) && evt === 'add' || evt === 'change') {
      files.push(resolve(file));
      update();
    }
  });

  liveServer.start({
    logLevel: 0,
    port: opts.port,
    root: opts.destDir,
    open: opts.open !== false,
    mount: [
      ['/', resolve(__dirname, '../public')],
      ['/vendor', resolve(__dirname, '../node_modules/somedom/dist')],
    ],
    middleware: [(req, res, next) => {
      if (req.url === '/templates.json') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(templates.map(x => basename(x, '.pug'))));
      } else {
        next();
      }
    }],
  });

  process.stdout.write(`\rPreview your templates at http://localhost:${opts.port || 8080}\n`); // eslint-disable-line
};
