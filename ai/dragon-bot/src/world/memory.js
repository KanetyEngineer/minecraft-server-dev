// 覚えておくこと（拠点・ポータル・要塞の場所、メモ、死亡地点）を JSON に保存する。
import fs from 'node:fs';
import path from 'node:path';

export class Memory {
  constructor(dir) {
    this.file = path.join(dir, 'memory.json');
    this.data = { places: {}, notes: [], deaths: [], eyeThrows: [], flags: {} };
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(this.file)) this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch {
      // 壊れていたら空から始める
    }
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  setPlace(name, pos, dimension) {
    this.data.places[name] = {
      x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), dimension,
    };
    this.save();
  }

  getPlace(name) {
    return this.data.places[name];
  }

  note(text) {
    this.data.notes.push({ at: new Date().toISOString(), text });
    this.data.notes = this.data.notes.slice(-20);
    this.save();
  }

  setFlag(name, value = true) {
    this.data.flags[name] = value;
    this.save();
  }

  flag(name) {
    return this.data.flags[name];
  }
}
