import scdl from 'soundcloud-downloader';

const url = 'https://api-v2.soundcloud.com/tracks/2151522561';
// Wait, we need a client ID or does it find it automatically?
async function test() {
  try {
    console.log('Testing scdl.download with api-v2 URL...');
    const stream = await scdl.default.download(url);
    console.log('Success! Stream class:', stream.constructor.name);
  } catch (e) {
    console.error('SCDL Error:', e.message);
    if (e.response) {
      console.error('Response status:', e.response.status);
      console.error('Response data:', e.response.data);
    }
  }
}

test();
