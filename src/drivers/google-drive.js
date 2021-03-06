const Drive = require('../utils/drive');
const Request = require('request');
const Ls = require('ls');
const Fs = require('fs');
const Path = require('path');

const getMetaFromArchive = require('../utils/extract/archive');
const getMetaFromFolder = require('../utils/extract/gdrive-folder');

const {
  upsertSource,
  upsertSongs,
  upsertLinksToIgnore,
  getLinksMapBySource,
} = require('../utils/db');

const download = url => new Promise((resolve, reject) =>
  Request.get(url, { encoding: null }, (err, res) => {
    if (err) reject(err);
    else resolve(res.body);
  })
);

const defaultNameParser = txt => {
  let [artist, ...songParts] = txt.split(' - ');
  if (!songParts || !songParts.length) return { artist: 'N/A', name: txt.replace(/\.(zip|rar|7z)$/, '') };
  const name = songParts.join(' - ').replace(/\.(zip|rar|7z)$/, '');
  return { artist: artist.trim(), name: name.trim() };
};

module.exports = async ({ name, link, proxy }) => {
  console.log('Adding', name);
  // Supporting both https://drive.google.com/open?id=<drive_id>
  // and https://drive.google.com/drive/folders/<drive_id> syntaxes
  // `proxy` is a link that will be displayed instead of the link as a source (useful for rehosts)
  const questionMarkIndex = link.indexOf('?');
  const source = {
    name, link: proxy || link,
    id: link.indexOf('/open?id=') > -1 ?
      link.slice(link.indexOf('/open?id=') + 9) :
      link.slice(link.lastIndexOf('/') + 1, questionMarkIndex < 0 ? undefined : questionMarkIndex)
  };
  
  // 1. Registering the source, or finding its ID if it already exists
  console.log('Registering/finding source');
  source.chorusId = (await upsertSource(source)).id;
  if (source.proxy) source.link = link;

  // 2. Get the map of already indexed links so that they don't get parsed again
  const linksMap = await getLinksMapBySource(source);
  
  /*
    3. Attempt to discover songs inside the drive
    A song can be either a folder with "song.ini", "notes.chart" and audio files in it,
    or archives (.zip/.rar/.7z).
  */
  console.log('Looking for chart folders and archives');
  const songs = [];
  const toIgnore = [];
  const searchSongFolders = async folder => {
    console.log('Looking inside', folder.name);
    // List files inside the folder
    const archives = [];
    let { subfolders, files } = (await Drive.list({ q: `'${folder.id}' in parents` }))
      .reduce((content, item) => {
        // Do not parse already indexed songs
        if (linksMap[item.webViewLink] && (linksMap[item.webViewLink].lastModified || '').slice(0, 19) == item.modifiedTime.slice(0, 19)) {
          songs.push(Object.assign(linksMap[item.webViewLink], {
            source, parent: folder.canBeParent ? {
              name: folder.name,
              link: folder.webViewLink
            } : null
          }));
          return content;
        }
        // Retrieve already indexed packs
        const firstLink = `${item.webViewLink}&i=1`;
        if (linksMap[firstLink] && (linksMap[firstLink].lastModified || '').slice(0, 19) == item.modifiedTime.slice(0, 19)) {
          for (let i = 1; linksMap[`${item.webViewLink}&i=${i}`]; i++) {
            songs.push(Object.assign(linksMap[`${item.webViewLink}&i=${i}`], {
              source, isPack: true, parent: folder.canBeParent ? {
                name: folder.name,
                link: folder.webViewLink
              } : null
            }));
          }
          return content;
        }
        if (linksMap[item.webViewLink] && linksMap[item.webViewLink].ignore) return content;
        // Save subfolders for further processing
        if (item.mimeType == 'application/vnd.google-apps.folder') {
          content.subfolders.push(item);
        } else if ((['rar', 'zip', '7z'].indexOf(item.fileExtension) >= 0) && item.size < 209715200 && item.webContentLink) {
          // Archives might or might not be songs.
          // The 200 MB threshold is just mostly here to not kill my bandwidth with multi-GB packs, which are therefore excluded.
          // The good practice for such packs would be to rehost it (either by individual charters, or independently with separate
          // folders/archives for each song)
          archives.push(item);
        // Pick up interesting files along the way
        // (just take the first occurrence of charts and mids)
        } else if (item.name == 'song.ini') {
          content.files.ini = item;
        } else if (item.fileExtension == 'chart' && !content.files.chart) {
          content.files.chart = item;
        } else if (item.fileExtension == 'mid' && !content.files.mid) {
          content.files.mid = item;
        } else if (item.name.match(
          /^(guitar|bass|rhythm|drums|vocals|keys|song)\.(ogg|mp3|wav)$/i
        )) {
          if (!content.files.audio) content.files.audio = [];
          content.files.audio.push(item);
        } else if (item.name.slice(0, 6) == 'video.') {
          content.files.video = item;
        }
        return content;
      }, { subfolders: [], files: {} });
    
    // Process archives
    for (let i = 0; i < archives.length; i++) {
      const file = archives[i];
      if (linksMap[file.webViewLink] && linksMap[file.webViewLink].ignore) continue;
      console.log('Extracting', file.name);
      const archive = await download(file.webContentLink);
      const metaList = await getMetaFromArchive(archive, file.fileExtension);
      if (!metaList || !metaList.length) toIgnore.push({ sourceId: source.chorusId, link: file.webViewLink });
      else {
        // Computing default artist and song names in case there's no song.ini file,
        // and also inputing already available metadata
        const { artist: defaultArtist, name: defaultName } = defaultNameParser(file.name);
        const song = {
          defaultArtist, defaultName, lastModified: file.modifiedTime, source, link: file.webViewLink,
          isPack: metaList.length > 1, parent: folder.canBeParent ? {
            name: folder.name,
            link: folder.webViewLink
          } : null
        };
        metaList.forEach((meta, index) => {
          console.log(`> Found "${
            meta.name || (meta.chartMeta || {}).Name || defaultName
          }" by "${
            meta.artist || (meta.chartMeta || {}).Artist || defaultArtist || '???'
          }"`);
          // An awful trick to have unique links for multiple items in a pack
          songs.push(Object.assign({}, song, meta, { link: song.isPack ? `${song.link}&i=${index+1}` : song.link }));
        });
      }
    }

    // If the folder contains a "song.ini", a .chart or a .mid,
    // it's probably a chart folder (maybe without audio in rare cases)
    const meta = await getMetaFromFolder(files);
    if (meta) {
      // Computing default artist and song names in case there's no song.ini file,
      // and also inputing already available metadata
      const { artist: defaultArtist, name: defaultName } = defaultNameParser(folder.name);
      // The parent of a folder is its own parent folder
      const song = {
        defaultArtist, defaultName, lastModified: folder.modifiedTime, source, link: folder.webViewLink, parent: folder.canBeParent && folder.parentFolder ? {
          name: folder.parentFolder.name,
          link: folder.parentFolder.webViewLink
        } : null
      };
      console.log(`> Found "${
        meta.name || (meta.chartMeta || {}).Name || defaultName
      }" by "${
        meta.artist || (meta.chartMeta || {}).Artist || defaultArtist || '???'
      }"`);
      songs.push(Object.assign(song, meta));
    }

    // Recurse on subfolders
    for (let i = 0; i < subfolders.length; i++) {
      if (folder.canBeParent) {
        subfolders[i].parentFolder = folder;
        subfolders[i].name = `${folder.name}/${subfolders[i].name}`;
      }
      subfolders[i].canBeParent = true;
      await searchSongFolders(subfolders[i]);
    }
  };
  await searchSongFolders(source);

  // 4. Update the list of links to ignore (e.g. invalid archives, stray files...)
  if (toIgnore.length) await upsertLinksToIgnore(toIgnore);

  // 5. Insert the songs with their metadata into the database
  if (songs.length) await upsertSongs(songs);
};
