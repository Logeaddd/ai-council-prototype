export async function readDroppedDirectory(root, limit) {
  const files = [];
  let truncated = false;

  async function visit(entry) {
    if (files.length >= limit) {
      truncated = true;
      return;
    }
    if (entry?.isFile) {
      const file = await readDroppedFile(entry);
      if (file) files.push(file);
      return;
    }
    if (!entry?.isDirectory || !entry.createReader) return;
    const children = await readAllDroppedEntries(entry);
    for (let index = 0; index < children.length; index += 1) {
      await visit(children[index]);
      if (files.length >= limit) {
        if (index < children.length - 1) truncated = true;
        break;
      }
    }
  }

  await visit(root);
  return { files, truncated };
}

function readDroppedFile(entry) {
  return new Promise((resolve, reject) => {
    if (!entry.file) {
      resolve(null);
      return;
    }
    entry.file(resolve, reject);
  });
}

async function readAllDroppedEntries(entry) {
  const reader = entry.createReader?.();
  if (!reader) return [];
  const all = [];
  while (true) {
    const batch = await new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (!batch.length) break;
    all.push(...batch);
  }
  return all;
}
