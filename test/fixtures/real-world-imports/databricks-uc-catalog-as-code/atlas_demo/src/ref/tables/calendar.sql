CREATE TABLE ref.calendar (
  day DATE NOT NULL COMMENT 'The day',
  week_start DATE COMMENT 'Monday of its week',
  month_start DATE COMMENT 'First day of its month',
  fiscal_quarter STRING COMMENT 'Such as FY27-Q2',
  CONSTRAINT calendar_pk PRIMARY KEY (day)
)
COMMENT 'One row per calendar day';
