const fs=require("fs");
const itemTags=JSON.parse(fs.readFileSync("data/item-tags.json","utf8"));
console.log(Object.keys(itemTags));
for (const k of Object.keys(itemTags)) {
  console.log(k, Array.isArray(itemTags[k]) ? itemTags[k].length : typeof itemTags[k]);
}
const catalog=JSON.parse(fs.readFileSync("data/catalog.json","utf8"));
console.log("catalog keys", Array.isArray(catalog) ? "array len "+catalog.length : Object.keys(catalog));
