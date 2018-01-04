const hatchet = require('hatchet');
const url = process.env.SIGNUP;

function sendHatchetMessage(url, json, form) {
  return new Promise((resolve, reject) => {
    hatchet.send(
      "send_post_request",
      { url, json, form },
      (err, response) => {
        if (err) {
          return reject(err);
        }

        resolve(payload);
      }
    );
  })
}

module.exports = async function signupRoutes(transaction, callback) {
  const payload = {
    format: 'html',
    lang: transaction.locale,
    newsletters: 'mozilla-foundation',
    trigger_welcome: 'N',
    source_url: 'https://donate.mozilla.org/',
    email: transaction.email,
    country: transaction.country
  };

  return await sendHatchetMessage(url, true, payload);
};
