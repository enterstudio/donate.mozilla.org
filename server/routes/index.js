const iron = require('iron');
const Boom = require('boom');
const mailchimpSignup = require('./mailchimp');
const stripe = require('./stripe');
const paypal = require('./paypal');
const basket = require('../lib/basket-queue.js');
const amountModifier = require('../../dist/lib/amount-modifier.js');

const cookiePassword = process.env.SECRET_COOKIE_PASSWORD;

async function decrypt(encryptedCookie) {
  try {
    return await iron.unseal(encryptedCookie, cookiePassword, iron.defaults);
  } catch (err) {
    return Promise.reject(err);
  }
}

async function encrypt(cookie) {
  try {
    return await iron.seal(cookie, cookiePassword, iron.defaults);
  } catch (err) {
    return Promise.reject(err);
  }
}


const mailchimp = async function(request, h) {
  const transaction = request.payload;
  const signup_service = Date.now();

  try {
    const payload = await mailchimpSignup(transaction);
  } catch (err) {
    request.log(['error', 'mailchimp'], {
      request_id: request.headers['x-request-id'],
      service: Date.now() - signup_service,
      code: err.code,
      type: err.type,
      param: err.param
    });

    return Boom.boomify(err, 500, 'Unable to complete Mailchimp signup');
  }


  var body = JSON.parse(payload.body);

  if (payload.statusCode !== 200) {
    request.log(['error', 'mailchimp'], {
      request_id: request.headers['x-request-id'],
      service: Date.now() - signup_service,
      code: payload.statusCode,
      message: body.title
    });

    return new Boom(payload.statusCode, 'Unable to complete Mailchimp signup', body);
  }

  request.log(['mailchimp'], {
    request_id: request.headers['x-request-id'],
    service: Date.now() - signup_service
  });

  return h.response(body).code(201);
};

const routes = {
  signup: require('./signup'),
  mailchimp,
  'stripe': async function(request, h) {
    const transaction = request.payload || {};
    const {
      currency,
      email,
      locale,
      description,
      stripeToken,
      frequency,
      signup,
      country
    } = transaction;
    const amount = amountModifier.stripe(transaction.amount, currency);
    const metadata = { email, locale };
    const request_id = request.headers['x-request-id'];

    let badRequest;
    let stripe_charge_create_service;
    let stripe_create_subscription_service;
    let stripe_customer_create_service;

    if (description.indexOf("Thunderbird") >= 0 ) {
      metadata.thunderbird = true;
    } else if (description.indexOf("glassroomnyc") >= 0 ) {
      metadata.glassroomnyc = true;
    }

    const startCreateCustomer = Date.now();
    let customer;

    try {
      customer = await stripe.customer({ metadata, email, stripeToken });
    } catch (err) {
        stripe_customer_create_service = Date.now() - startCreateCustomer;
        badRequest = Boom.badRequest('Stripe charge failed');

        badRequest.output.payload.stripe = {
          code: err.code,
          rawType: err.rawType
        };

        request.log(['error', 'stripe', 'customer'], {
          request_id,
          stripe_customer_create_service,
          code: err.code,
          type: err.type,
          param: err.param
        });

        return badRequest;
    }

    stripe_customer_create_service = Date.now() - startCreateCustomer;

    request.log(['stripe', 'customer'], {
      request_id,
      stripe_customer_create_service,
      customer_id: customer.id
    });

    if (frequency !== 'monthly') {
      const startCreateCharge = Date.now();
      let charge;

      try {
        charge = await stripe.single({ amount, currency, metadata, description, customer: customer.id });
      } catch (err) {
        stripe_charge_create_service = Date.now() - startCreateCharge;
        badRequest = Boom.badRequest('Stripe charge failed');

        badRequest.output.payload.stripe = {
          code: err.code,
          rawType: err.rawType
        };

        request.log(['error', 'stripe', 'single'], {
          request_id,
          stripe_charge_create_service,
          customer_id: customer.id,
          code: err.code,
          type: err.type,
          param: err.param
        });

        return badRequest;
      }

      stripe_charge_create_service = Date.now() - startCreateCharge;

      if (signup) {
        const signup_service = Date.now();

        signup(transaction, (signup_error, payload) => {
          if (signup_error) {
            return request.log(['error', 'signup'], {
              request_id: request.headers['x-request-id'],
              service: Date.now() - signup_service,
              code: signup_error.code,
              type: signup_error.type,
              param: signup_error.param
            });
          }

          request.log(['signup'], {
            request_id: request.headers['x-request-id'],
            service: Date.now() - signup_service
          });
        });
      }

      request.log(['stripe', 'single'], {
        request_id,
        stripe_charge_create_service,
        charge_id: charge.id
      });

      basket.queue({
        event_type: "donation",
        last_name: charge.source.name,
        email: charge.metadata.email,
        donation_amount: basket.zeroDecimalCurrencyFix(charge.amount, charge.currency),
        currency: charge.currency,
        created: charge.created,
        recurring: false,
        service: "stripe",
        transaction_id: charge.id,
        project: metadata.thunderbird ? "thunderbird" : ( metadata.glassroomnyc ? "glassroomnyc" : "mozillafoundation" )
      });

      const cookie = {
        stripeCustomerId: customer.id
      };
      const response = {
        frequency: "one-time",
        amount: charge.amount,
        currency: charge.currency,
        id: charge.id,
        signup,
        country,
        email
      };

      try {
        const encryptedCookie = await encrypt(cookie);
        return h.response(response)
          .state("session", encryptedCookie)
          .code(200);

      } catch (err) {
        request.log(['error', 'stripe', 'single', 'cookie'], {
          request_id,
          customer_id: customer.id,
          code: err.code,
          message: err.message
        });

        return h.response(response).code(200);
      };

    } else {
      // Monthly Stripe donation
      let startCreateSubscription = Date.now();
      let stripe_create_subscription_service;
      let subscription;

      try {
        subscription = await stripe.recurring({
          // Stripe has plans with set amounts, not custom amounts.
          // So to get a custom amount we have a plan set to 1 cent, and we supply the quantity.
          // https://support.stripe.com/questions/how-can-i-create-plans-that-dont-have-a-fixed-price
          currency,
          metadata,
          customer,
          stripeToken,
          email,
          quantity: amount
        });
      } catch (err) {
        stripe_create_subscription_service = Date.now() - startCreateSubscription;
        badRequest = Boom.badRequest('Stripe subscription failed', {
          code: err.code,
          rawType: err.rawType
        });

        request.log(['error', 'stripe', 'recurring'], {
          request_id,
          stripe_create_subscription_service,
          customer_id: customer.id,
          code: err.code,
          type: err.type,
          param: err.param
        });

        return badRequest;
      }

      stripe_create_subscription_service = Date.now() - startCreateSubscription;

      if (signup) {
        const signup_service = Date.now();

        signup(transaction, (signup_error, payload) => {
          if (signup_error) {
            return request.log(['error', 'signup'], {
              request_id: request.headers['x-request-id'],
              service: Date.now() - signup_service,
              code: signup_error.code,
              type: signup_error.type,
              param: signup_error.param
            });
          }

          request.log(['signup'], {
            request_id: request.headers['x-request-id'],
            service: Date.now() - signup_service
          });
        });
      }

      request.log(['stripe', 'recurring'], {
        request_id,
        stripe_create_subscription_service,
        customer_id: customer.id
      });

      return h.response({
        frequency: "monthly",
        currency: subscription.plan.currency,
        quantity: subscription.quantity,
        id: subscription.id,
        signup,
        country,
        email
      }).code(200);
    }
  },
  stripeMonthlyUpgrade: async function(request, h) {
    const transaction = request.payload || {};
    const encryptedCookie = request.state && request.state.session;
    const { currency } = transaction;
    const amount = amountModifier.stripe(transaction.amount, currency);
    const metadata = {
      locale: transaction.locale
    };
    const request_id = request.headers['x-request-id'];

    let cookie;

    if (transaction.description.indexOf("Thunderbird") >= 0 ) {
      metadata.thunderbird = true;
    } else if (transaction.description.indexOf("glassroomnyc") >= 0 ) {
      metadata.glassroomnyc = true;
    }

    if (!encryptedCookie) {
      request.log(['error', 'stripe', 'recurring', 'upgrade'], {
        request_id,
        err: 'Cookie does not exist'
      });

      return Boom.badRequest('An error occurred while creating this monthly donation');
    }

    try {
      cookie = await decrypt(encryptedCookie);
    } catch (err) {
      request.log(['error', 'stripe', 'recurring', 'upgrade'], {
        request_id,
        code: err.code,
        message: err.message
      });

      return Boom.badImplementation('An error occurred while creating this monthly donation');
    }
    const customerId = cookie && cookie.stripeCustomerId;

    if (!customerId) {
      request.log(['error', 'stripe', 'recurring', 'upgrade'], {
        request_id,
        err: 'Customer ID missing from the cookie'
      });

      return reply(Boom.badRequest('An error occurred while creating this monthly donation'));
    }

    let customer;

    try {
      customer = await stripe.retrieveCustomer(customerId);
    } catch (err) {
        return Boom.badImplementation('An error occurred while creating this monthly donation', err);
    }

    const { id: customer_id } = customer;
    let startCreateSubscription = Date.now();
    let stripe_create_subscription_service;
    let subscription;

    try {
      // Make this with a monthly delay for the user.
      subscription = await stripe.recurring({
        // Stripe has plans with set amounts, not custom amounts.
        // So to get a custom amount we have a plan set to 1 cent, and we supply the quantity.
        // https://support.stripe.com/questions/how-can-i-create-plans-that-dont-have-a-fixed-price
        currency,
        metadata,
        customer,
        quantity: amount,
        trialPeriodDays: "30"
      });
    } catch (err) {
      stripe_create_subscription_service = Date.now() - startCreateSubscription;
      const { code, type, param } = err;

      request.log(['error', 'stripe', 'recurring', 'upgrade'], {
        request_id,
        stripe_create_subscription_service,
        customer_id,
        code,
        type,
        param
      });

      return Boom.badRequest('Stripe subscription failed', {
        code: err.code,
        rawType: err.rawType
      });
    }

    stripe_create_subscription_service = Date.now() - startCreateSubscription;

    request.log(['stripe', 'recurring', 'upgrade'], {
      request_id,
      stripe_create_subscription_service,
      customer_id
    });

    return h.response({
      frequency: "monthly",
      currency: subscription.plan.currency,
      quantity: subscription.quantity,
      id: subscription.id
    })
      .unstate("session")
      .code(200);
  },
  'paypal': async function(request, h) {
    var transaction = request.payload || {};
    var frequency = transaction.frequency || "";
    var currency = transaction.currency;
    var amount = amountModifier.paypal(transaction.amount, currency);

    var details = {
      amount: amount,
      currency: currency,
      locale: transaction.locale,
      item_name: transaction.description,
      serverUri: request.server.info.uri,
      frequency: frequency,
      appName: transaction.appName
    };
    var request_id = request.headers['x-request-id'];
    function callback(err, data) {
      var paypal_request_sale_service = data.paypal_request_sale_service;

      if (err) {
      } else {
      }
    }
    const paypalRequestSaleStart = Date.now();

    let checkoutDetails;
    let log_details = { request_id };
    let paypal_request_sale_service;

    try {
      checkoutDetails = await paypal.setupCheckout(details);
    } catch (err) {
      const {err: httpErr, response} = err
      paypal_request_sale_service = Date.now() - paypalRequestSaleStart;
      log_details.error = httpErr.toString();

      if (response) {
        log_details.error_name = response.name;
        log_details.error_message = response.message;
        log_details.details = response.details;
      }

      request.log(['paypal', 'sale', 'error', frequency], log_details);

      return Boom.boomify(httpErr, 500, 'Paypal donation failed');
    }

    paypal_request_sale_service = Date.now() - paypalRequestSaleStart;

    request.log(['paypal', 'sale', frequency], log_details);

    return h.response({
      endpoint: process.env.PAYPAL_ENDPOINT,
      token: checkoutDetails.TOKEN
    }).code(200);
  },
  'paypal-redirect': async function(request, h) {
    var locale = request.params.locale || '';
    if (locale) {
      locale = '/' + locale;
    }
    var appName = request.params.appName;
    var location = "thank-you";
    if (appName === "thunderbird") {
      location = "thunderbird/" + location;
    }
    var frequency = request.params.frequency || 'single';
    var options = {
      recurring: frequency === 'monthly',
      accountType: request.params.accountType
    };
    var request_id = request.headers['x-request-id'];
    if (frequency !== 'monthly') {
      let checkoutDetails;
      let paypal_checkout_details_service

      const paypalCheckoutDetailsStart = Date.now();
      try {
        checkoutDetails = await paypal.getCheckoutDetails({
          token: request.url.query.token
        }, options);
      } catch (err) {
          paypal_checkout_details_service = Date.now() - paypalCheckoutDetailsStart;
          request.log(['error', 'paypal', 'checkout-details', frequency], {
            request_id,
            paypal_checkout_details_service,
            // https://developer.paypal.com/docs/api/#errors
            error_name: checkoutDetails.response.name,
            error_message: checkoutDetails.response.message,
            details: checkoutDetails.response.details
          });
          return Boom.badRequest('donation failed', err);
      }

      paypal_checkout_details_service = Date.now() - paypalCheckoutDetailsStart;

      request.log(['paypal', 'checkout-details', frequency], {
        request_id,
        paypal_checkout_details_service
      });

      let checkoutData;
      let paypal_checkout_payment_service;
      let log_details = {
        request_id,
      };

      const paypalCheckoutPaymentStart = Date.now();

      try {
        checkoutData = await paypal.completeCheckout(checkoutDetails.response, options);
      } catch (err) {
        paypal_checkout_payment_service = Date.now() - paypalCheckoutPaymentStart;
        log_details.paypal_checkout_payment_service = paypal_checkout_payment_service;

        log_details.error = err.toString();

        if (checkoutData.response) {
          log_details.error_name = checkoutData.response.name;
          log_details.error_message = checkoutData.response.message;
          log_details.details = checkoutData.response.details;
        }

        request.log(['error', 'paypal', 'checkout-payment', frequency], log_details);
        return Boom.badRequest('donation failed', err);
      }

      paypal_checkout_payment_service = Date.now() - paypalCheckoutPaymentStart;

      request.log(['paypal', 'checkout', frequency], log_details);

      var timestamp = new Date(checkoutData.txn.PAYMENTINFO_0_ORDERTIME).getTime() / 1000;

      basket.queue({
        event_type: "donation",
        first_name: checkoutDetails.response.FIRSTNAME,
        last_name: checkoutDetails.response.LASTNAME,
        email: checkoutDetails.response.EMAIL,
        donation_amount: checkoutData.txn.PAYMENTREQUEST_0_AMT,
        currency: checkoutData.txn.CURRENCYCODE,
        created: timestamp,
        recurring: false,
        service: 'paypal',
        transaction_id: checkoutData.txn.PAYMENTINFO_0_TRANSACTIONID,
        project: appName
      });

      return h.redirect(`${locale}/${location}/?frequency=${frequency}&tx=${checkoutData.txn.PAYMENTINFO_0_TRANSACTIONID}&amt=${data.txn.PAYMENTREQUEST_0_AMT}&cc=${data.txn.CURRENCYCODE}`);
    } else {
      paypal.getCheckoutDetails({
        token: request.url.query.token
      }, options, function(err, checkoutDetails) {
        var paypal_checkout_details_service = checkoutDetails.paypal_checkout_details_service;
        var log_details = {
          request_id,
          paypal_checkout_details_service
        };

        if (err) {
          log_details.error = err.toString();

          if (checkoutDetails.response) {
            log_details.error_name = checkoutDetails.response.name;
            log_details.error_message = checkoutDetails.response.message;
            log_details.details = checkoutDetails.response.details;
          }

          request.log(['error', 'paypal', 'checkout-details', frequency], log_details);
          return reply(Boom.badRequest('donation failed', err));
        }

        request.log(['paypal', 'checkout-details', frequency], log_details);

        paypal.completeCheckout(checkoutDetails.response, options, function(err, data) {
          var paypal_checkout_payment_service = data.paypal_checkout_payment_service;
          var log_details = {
            request_id,
            paypal_checkout_payment_service
          };

          if (err) {
            log_details.error = err;

            if (data.response) {
              log_details.error_name = data.response.name;
              log_details.error_message = data.response.message;
              log_details.details = data.response.details;
            }

            request.log(['error', 'paypal', 'checkout-payment', frequency], log_details);
            return reply(Boom.boomify(err));
          }

          request.log(['paypal', 'checkout', frequency], log_details);

          var timestamp = new Date(data.txn.TIMESTAMP).getTime() / 1000;

          // Create unique tx id by combining PayerID and timestamp
          var stamp = Date.now() / 100;
          var txId = data.txn.PAYERID + stamp;

          basket.queue({
            event_type: "donation",
            first_name: checkoutDetails.response.FIRSTNAME,
            last_name: checkoutDetails.response.LASTNAME,
            email: checkoutDetails.response.EMAIL,
            donation_amount: data.txn.AMT,
            currency: data.txn.CURRENCYCODE,
            created: timestamp,
            recurring: true,
            frequency: "monthly",
            service: "paypal",
            transaction_id: txId,
            subscription_id: data.txn.PROFILEID,
            project: appName
          });

          reply.redirect(`${locale}/${location}/?frequency=${frequency}&tx=${txId}&amt=${data.txn.AMT}&cc=${data.txn.CURRENCYCODE}`);
        });
      });
    }
  },
  'stripe-charge-refunded': function(request, reply) {
    var endpointSecret = process.env.STRIPE_WEBHOOK_SIGNATURE_CHARGE_REFUNDED;
    var signature = request.headers["stripe-signature"];

    var event = stripe.constructEvent(request.payload, signature, endpointSecret);

    if (!event) {
      return reply(Boom.forbidden('An error occurred while verifying the webhook signing secret'));
    }

    if (event.type !== 'charge.refunded') {
      return reply('This hook only processes charge.refunded events');
    }

    var event_type = event.type;
    var charge = event.data.object;
    var refund = charge.refunds.data[0];

    var transaction_id = charge.id;
    var reason = refund.reason;
    var status = refund.status;

    if (reason === null) {
      // refunded via dashboard, mark as requested_by_customer
      reason = 'requested_by_customer';
    }

    basket.queue({
      event_type,
      transaction_id,
      reason,
      status
    });

    return reply("charge event processed");
  },
  'stripe-dispute': function(request, reply) {
    var endpointSecret = process.env.STRIPE_WEBHOOK_SIGNATURE_DISPUTE;
    var signature = request.headers["stripe-signature"];

    var event = stripe.constructEvent(request.payload, signature, endpointSecret);

    if (!event) {
      return reply(Boom.forbidden('An error occurred while verifying the webhook signing secret'));
    }


    var disputeEvents = [
      'charge.dispute.closed',
      'charge.dispute.created',
      'charge.dispute.updated'
    ];


    if (disputeEvents.indexOf(event.type) === -1) {
      return reply('This hook only processes disputes');
    }

    var dispute = event.data.object;

    // kick off a Promise Chain
    Promise.resolve()
      .then(function() {
      // close the dispute automatically if it's not lost already
        if (event === 'charge.dispute.created' && dispute.status === 'lost') {
          return Promise.resolve();
        }

        return stripe.closeDispute(dispute.id)
          .catch(function(closeDisputeError) {
            if (closeDisputeError.message === 'This dispute is already closed') {
              return console.log(closeDisputeError.message);
            }

            return Promise.reject("Could not close the dispute");
          });
      })
      .then(function() {
        basket.queue({
          event_type: event.type,
          transaction_id: dispute.charge,
          reason: dispute.reason,
          status: dispute.status
        });

        reply("dispute processed");
      })
      .catch(function(err) {
        if (err.isBoom) {
          return reply(err);
        }

        return reply(Boom.badImplementation('An error occurred while handling the dispute webhook', err));
      });


  },
  'stripe-charge-succeeded': function(request, reply) {
    var endpointSecret = process.env.STRIPE_WEBHOOK_SIGNATURE_CHARGE_SUCCESS;
    var signature = request.headers["stripe-signature"];

    var event = stripe.constructEvent(request.payload, signature, endpointSecret);

    if (!event) {
      return reply(Boom.forbidden('An error occurred while verifying the webhook signing secret'));
    }

    var charge = event.data.object;

    if (event.type !== 'charge.succeeded') {
      return reply('This hook only processes charge succeeded events');
    }

    stripe.retrieveCharge(
      charge.id,
      function(fetchChargeErr, charge) {
        if (fetchChargeErr) {
          return reply(Boom.badImplementation('An error occurred while fetching the invoice for this charge', fetchChargeErr));
        }

        if (!charge.invoice || !charge.invoice.subscription) {
          return reply('Charge not part of a subscription');
        }

        stripe.retrieveSubscription(
          charge.invoice.customer,
          charge.invoice.subscription,
          {
            expand: ["customer"]
          },
          function(retrieveSubscriptionErr, subscription) {
            if (retrieveSubscriptionErr) {
              return reply(Boom.badImplementation('An error occurred while fetching the subscription for this charge\'s invoice', retrieveSubscriptionErr));
            }

            var updateData = {
              metadata: subscription.metadata
            };

            if (updateData.metadata.thunderbird) {
              updateData.description = 'Thunderbird monthly';
            } else if (updateData.metadata.glassroomnyc) {
              updateData.description = 'glassroomnyc monthly';
            } else {
              updateData.description = 'Mozilla Foundation Monthly Donation';
            }

            // capture recurring stripe transactions in salesforce
            basket.queue({
              event_type: "donation",
              last_name: subscription.customer.sources.data[0].name,
              email: subscription.customer.email,
              donation_amount: basket.zeroDecimalCurrencyFix(charge.amount, charge.currency),
              currency: charge.currency,
              created: charge.created,
              recurring: true,
              frequency: "monthly",
              service: "stripe",
              transaction_id: charge.id,
              subscription_id: subscription.id,
              project: updateData.metadata.thunderbird ? "thunderbird" : ( updateData.metadata.glassroomnyc ? "glassroomnyc" : "mozillafoundation" )
            });

            stripe.updateCharge(charge.id, updateData, function(updateChargeErr) {
              if (updateChargeErr) {
                return reply(Boom.badImplementation('An error occurred while updating the charge'));
              }

              reply('Charge updated');
            });
          }
        );
      }
    );
  },
  'stripe-charge-failed': require('./webhooks/stripe-charge-failed.js')
};

module.exports = routes;
