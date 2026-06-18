import 'dotenv/config';
import { resetOtherTariffsToFree, resetExpiredPremiumsBulk } from '../db.js';

async function main() {
  try {
    console.log('Running resetOtherTariffsToFree...');
    const othersRes = await resetOtherTariffsToFree();
    console.log('resetOtherTariffsToFree result:', othersRes);

    console.log('Running resetExpiredPremiumsBulk...');
    const expiredRes = await resetExpiredPremiumsBulk();
    console.log('resetExpiredPremiumsBulk result:', expiredRes);
  } catch (e) {
    console.error('Error occurred:', e);
  }
}

main();
