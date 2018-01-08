const boom = require('boom');
const hatchet = require('hatchet');

const listSignup = require('./signup');

const url = process.env.SIGNUP;

async function signupRoutes(transaction) {
  const payload = {
    format: 'html',
    lang: transaction.locale,
    newsletters: 'mozilla-foundation',
    trigger_welcome: 'N',
    source_url: 'https://donate.mozilla.org/',
    email: transaction.email,
    country: transaction.country
  };

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
};

module.exports = async function(request, h) {
  const transaction = request.payload;
  const signup_service = Date.now();

  try {
    const payload = await signupRoutes(transaction);
  } catch (err) {
    request.log(['error', 'signup'], {
      request_id: request.headers['x-request-id'],
      service: Date.now() - signup_service,
      code: err.code,
      type: err.type,
      param: err.param
    });

    return boom.wrap(err, 500, 'Unable to complete Basket signup');
  }

  request.log(['signup'], {
    request_id: request.headers['x-request-id'],
    service: Date.now() - signup_service
  });

  return h.response(payload).code(201);
}