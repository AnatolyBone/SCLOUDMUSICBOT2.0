import scdl from 'soundcloud-downloader';
import { fromMediaObj } from 'soundcloud-downloader/dist/download.js';

const trackId = 2151522561;

async function test() {
  try {
    console.log('Fetching track info by ID...');
    const clientID = await scdl.default.getClientID();
    console.log('ClientID:', clientID);
    
    const trackInfos = await scdl.default.getTrackInfoByID([trackId]);
    console.log('Got track info! Title:', trackInfos[0]?.title);
    
    const transcoding = trackInfos[0]?.media?.transcodings?.[0];
    if (!transcoding) {
      console.log('No transcodings found!');
      return;
    }
    console.log('Transcoding URL:', transcoding.url);
    
    // Now try to download using fromMediaObj
    console.log('Downloading using fromMediaObj...');
    const stream = await fromMediaObj(transcoding, clientID, scdl.default.axios);
    console.log('Success! Stream class:', stream.constructor.name);
  } catch (e) {
    console.error('Error:', e.message);
  }
}

test();
