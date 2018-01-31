const Boom = require('boom');
const stripe = require('../stripe');
const basket = require('../../lib/basket-queue');

// values that never change between webhook requests
const signatureHeader = 'stripe-signature';
const event_type = 'charge.failed';
const frequency = 'monthly';
const recurring = true;
const service = 'stripe';

// Error/Success message constants
const forbiddenError = 'An error occurred while verifying the webhook signing secret';
const incorrectEvent = 'This hook only processes charge failed events';
const expandChargeError = 'An error occurred while expanding the charge';
const retrieveSubscriptionErrorMsg = 'An error occurred while fetching the subscription';
const notRecurringCharge = 'This hook only processes recurring charges that fail';
const notPartOfSubscription = 'This charge is not part of a subscription';
const successMessage = 'charge failed event processed';

let stripeChargeFailed = (request, h) => {
  // Validate the Webhook signature
  let endpointSecret = process.env.STRIPE_WEBHOOK_SIGNATURE_CHARGE_FAILED;
  let signature = request.headers[signatureHeader];

  let event = stripe.constructEvent(request.payload, signature, endpointSecret);

  // If there's no event object, the signature verification failed
  if (!event) {
    return Boom.forbidden(forbiddenError);
  }

  // Only process charge.failed webhook events
  if (event.type !== event_type) {
    return h.response(incorrectEvent);
  }

  let charge = event.data.object;

  // If the charge has no invoice ID, this is not a recurring charge
  if (!charge.invoice) {
    return h.response(notRecurringCharge);
  }

  // Expand the invoice object on the charge
  try {
    charge = stripe.retrieveCharge(charge.id);
  } catch (err) {
    return Boom.badImplementation(`${expandChargeError}: ${err}`);
  }

  // Unlikely, but ensure there's a subscription object to work with
  if (!charge.invoice || !charge.invoice.subscription) {
    return h.response(notPartOfSubscription);
  }

  let {customer, subscription} = charge.invoice;

  // Expand the subscription object
  try {
    subscription = stripe.retrieveSubscription(customer, subscription, { expand: ["customer"] });
  } catch (err) {
    return Boom.badImplementation(`${retrieveSubscriptionErrorMsg}: ${err}`);

  }

  // Capture the variables we need to pass to the CRM
  // Since this charge failed, we need to pass enough information
  // for the CRM to create a new Opportunity record, and mark it
  // immediately as 'Lost'
  let {
    currency,
    created,
    id: transaction_id,
    failure_code
  } = charge;

  let {
    id: subscription_id,
    metadata
  } = subscription;

  let last_name = subscription.customer.sources.data[0].name,
    email = subscription.customer.email,
    donation_amount = basket.zeroDecimalCurrencyFix(charge.amount, charge.currency),
    project = metadata.thunderbird ? "thunderbird" : ( metadata.glassroomnyc ? "glassroomnyc" : "mozillafoundation" );

  basket.queue({
    transaction_id,
    subscription_id,
    event_type,
    last_name,
    email,
    donation_amount,
    currency,
    created,
    recurring,
    frequency,
    service,
    project,
    failure_code
  });

  return h.response(successMessage);
};

module.exports = stripeChargeFailed;
