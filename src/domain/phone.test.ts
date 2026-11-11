import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLkMobile, isLkMobile, LK_MOBILE_PREFIXES, toLkMobile } from './phone.ts';

const phone = (input: unknown) => {
  const r = toLkMobile(input);
  return 'phone' in r ? r.phone : `refused: ${r.reason}`;
};

test('every everyday way of writing a mobile number comes out as +947XXXXXXXX', () => {
  for (const input of [
    '0771234567', '771234567', '+94771234567', '94771234567', '0094771234567',
    '077 123 4567', '077-123-4567', '+94 77 123 4567', '94-77-123-4567', '(077) 123 4567', '077.123.4567',
    ' 0771234567 ', '0771234567 ', '﻿0771234567', '077​1234567', "'0771234567",
  ]) assert.equal(phone(input), '+94771234567', JSON.stringify(input));
});

test('a number cell from Excel, with or without the country code', () => {
  assert.equal(phone(771234567), '+94771234567');
  assert.equal(phone(94771234567), '+94771234567');
  assert.match(phone(77.5), /^refused/);
  assert.match(phone(-771234567), /^refused/);
});

test('every mobile network is taken; landlines and unused prefixes are refused with the reason', () => {
  for (const p of LK_MOBILE_PREFIXES) assert.equal(phone(`0${p}1234567`), `+94${p}1234567`);
  assert.equal(phone('0112345678'), 'refused: a landline, not a mobile');
  assert.equal(phone('+94112345678'), 'refused: a landline, not a mobile');
  assert.equal(phone('0731234567'), 'refused: no mobile number starts with 073');
  assert.equal(phone('0791234567'), 'refused: no mobile number starts with 079');
});

test('wrong lengths, letters, blanks and lost digits are refused, never guessed', () => {
  assert.equal(phone('07712345'), 'refused: too short');
  assert.equal(phone('077123456789'), 'refused: too long');
  assert.equal(phone('077 ABC 4567'), 'refused: not a number');
  assert.equal(phone(''), 'refused: no number');
  assert.equal(phone('   '), 'refused: no number');
  assert.equal(phone(null), 'refused: no number');
  assert.equal(phone(undefined), 'refused: no number');
  assert.match(phone('9.47712E+10'), /format the column as Text/);
  assert.match(phone('7.71235e8'), /format the column as Text/);
});

test('two numbers in one cell: the first good one, the others given back', () => {
  assert.deepEqual(toLkMobile('0771234567 / 0712345678'), { phone: '+94771234567', others: ['+94712345678'] });
  assert.deepEqual(toLkMobile('0771234567, 0712345678; 0751112222'), { phone: '+94771234567', others: ['+94712345678', '+94751112222'] });
  assert.deepEqual(toLkMobile('0771234567 or 0712345678'), { phone: '+94771234567', others: ['+94712345678'] });
  // A landline first: the mobile is the customer's number.
  assert.deepEqual(toLkMobile('0112345678 / 0771234567'), { phone: '+94771234567' });
  // The same number twice is one number.
  assert.deepEqual(toLkMobile('0771234567 / +94 77 123 4567'), { phone: '+94771234567' });
  // Nothing good: the first reason.
  assert.deepEqual(toLkMobile('0112345678 / 123'), { reason: 'a landline, not a mobile' });
});

test('the stored form is recognised, and shown the way people say it', () => {
  assert.equal(isLkMobile('+94771234567'), true);
  assert.equal(isLkMobile('0771234567'), false);
  assert.equal(isLkMobile('+94731234567'), false);
  assert.equal(isLkMobile(771234567), false);
  assert.equal(formatLkMobile('+94771234567'), '077 123 4567');
  assert.equal(formatLkMobile('not one'), 'not one');
});
