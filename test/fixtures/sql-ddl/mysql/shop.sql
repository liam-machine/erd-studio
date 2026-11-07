-- Shop star schema (MySQL 8), as mysqldump --no-data writes it.
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
SET NAMES utf8mb4;

DROP TABLE IF EXISTS `dim_customer`;
CREATE TABLE `dim_customer` (
  `customer_id` int NOT NULL AUTO_INCREMENT COMMENT 'Surrogate key',
  `customer_name` varchar(200) NOT NULL,
  `country_code` char(2) DEFAULT 'AU',
  PRIMARY KEY (`customer_id`),
  KEY `ix_country` (`country_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='One row per customer';

CREATE TABLE `dim_product` (
  `product_id` int NOT NULL AUTO_INCREMENT,
  `sku` varchar(32) NOT NULL,
  `category` enum('hardware','software','service') DEFAULT NULL,
  PRIMARY KEY (`product_id`),
  UNIQUE KEY `uq_sku` (`sku`)
) ENGINE=InnoDB;

CREATE TABLE `dim_store` (
  `store_id` smallint NOT NULL,
  `store_name` varchar(100) NOT NULL COMMENT 'Trading name',
  PRIMARY KEY (`store_id`)
) ENGINE=InnoDB;

CREATE TABLE `fct_sale` (
  `sale_id` bigint NOT NULL,
  `line_no` int NOT NULL,
  `customer_id` int NOT NULL,
  `product_id` int NOT NULL,
  `store_id` smallint NOT NULL,
  `sold_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `amount` decimal(12,2) NOT NULL COMMENT 'Sale amount incl. tax',
  PRIMARY KEY (`sale_id`, `line_no`),
  KEY `ix_sold_at` (`sold_at`),
  CONSTRAINT `fk_sale_customer` FOREIGN KEY (`customer_id`) REFERENCES `dim_customer` (`customer_id`),
  CONSTRAINT `fk_sale_product` FOREIGN KEY (`product_id`) REFERENCES `dim_product` (`product_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE `fct_sale` ADD CONSTRAINT `fk_sale_store` FOREIGN KEY (`store_id`) REFERENCES `dim_store` (`store_id`);

CREATE VIEW `v_sales` AS SELECT * FROM `fct_sale`;
INSERT INTO `dim_store` VALUES (1, 'Sydney CBD');
