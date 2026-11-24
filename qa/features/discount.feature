Feature: Manager discounts never lose or invent money
  As the owner
  I want every discount rounded once, in whole cents
  So that the drawer always balances and no bill can be raised by a "discount"

  Background:
    Given an empty bill
    And I type "margherita, burger"

  Scenario: A 10% discount on a Rs 1,900 bill
    When the manager gives 10% off
    Then the net amount is Rs 1,710.00
    And the discount line shows Rs 190.00

  Scenario: Free order on a delivery waives the fee
    Given the order is a delivery with a fee of Rs 150.00
    When the manager makes the order Free
    Then the net amount is Rs 0.00

  Scenario: A negative percent can never raise the bill (BUG-01)
    When the manager gives -50% off
    Then the net amount is Rs 1,900.00
    And the sync server refuses the discount
