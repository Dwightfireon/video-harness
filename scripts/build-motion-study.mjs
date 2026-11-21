import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { browserSource } from '../lib/film.mjs';

const root = new URL('../demo/motion-polish-20261023/', import.meta.url);
const [template, study, player] = await Promise.all(['template.html', 'study.mjs', 'player.js'].map(file => readFile(new URL(file, root), 'utf8')));
const inline = source => source.replaceAll('</script', '<\\/script');
const html = template.replace('/* INLINE_FILM */', () => inline(browserSource()))
  .replace('/* INLINE_STUDY */', () => inline(study.replace(/^export /gm, '')))
  .replace('/* INLINE_PLAYER */', () => inline(player));
await writeFile(new URL('index.html', root), html);
console.log(`Built ${fileURLToPath(new URL('index.html', root))} — inline current lib/film.mjs; no fetch, models or audio.`);
