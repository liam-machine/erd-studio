# AdventureWorks OLTP (SQL Server)

AdventureWorks is Microsoft's main sample database for SQL Server. It models a bicycle maker: people, employees, products, manufacturing, purchasing and sales. This is the T-SQL install script, `instawdb.sql`, from Microsoft's `sql-server-samples` repository. It is the "AdventureWorks 2025" version.

## Where it came from

- Repository: https://github.com/microsoft/sql-server-samples
- File: https://github.com/microsoft/sql-server-samples/blob/8fe3fd0c9a825fef3ae6d601e97537b612d7b214/samples/databases/adventure-works/oltp-install-script/instawdb.sql
- Raw download: https://raw.githubusercontent.com/microsoft/sql-server-samples/8fe3fd0c9a825fef3ae6d601e97537b612d7b214/samples/databases/adventure-works/oltp-install-script/instawdb.sql
- Pin: repository commit `8fe3fd0c9a825fef3ae6d601e97537b612d7b214` (the tip of `master` on 2026-11-05). The last commit that changed this file is `1346b94fab23bfa7edfdb32afae52282ddc3bfaa` (2026-08-31). Git blob SHA `86d6e5f8b93641743bdd80a8a5e4895c71d86cef`.
- `instawdb.sql`: 329,368 bytes, SHA-256 `d979f036750f9c7b4fb7be3d58cdbb596a74f864a6325998501b3a96c6ad53f9`. UTF-8 with a BOM, CRLF line endings.
- Downloaded 2026-11-07.

## Licence

MIT, "Copyright (c) Microsoft Corporation", from the repository's `license.txt`. MIT asks for the notice to be kept, so `license.txt` is copied unchanged as `UPSTREAM-LICENSE.txt`. All data in AdventureWorks is fictitious (stated in the file header).

## What was copied

- `instawdb.sql`, byte for byte (same hash as above). Nothing was removed.
- The script holds no inline data. It loads rows with 68 `BULK INSERT ... FROM '$(SqlSamplesSourceDataPath)<Table>.csv'` statements. Those CSV files ship in a release zip, not in this folder, and were not copied.
- Not chosen: Northwind (`instnwnd.sql`, about 1 MB, mostly INSERT data, no schemas or user-defined types) and the data-warehouse script `instawdbdw.sql`. AdventureWorks OLTP has the most SQL Server features an importer could trip on.

## Expected counts

Counted with a small Python script over a comment-stripped copy of the file, never by running ERD Studio or SQL Server. Each `CREATE TABLE [schema].[name](...)` body was split on top-level commas. A part starting with `CONSTRAINT` is a table constraint; every other part is one column (computed columns included). Primary keys are the `ALTER TABLE ... WITH CHECK ADD CONSTRAINT [PK_...] PRIMARY KEY` statements, plus one inline PK on `dbo.ErrorLog`. Foreign keys are the `CONSTRAINT [FK_...] FOREIGN KEY (...) REFERENCES [schema].[table](...)` clauses inside the `ALTER TABLE ... ADD` statements. There are 90 `REFERENCES` in the file, which matches. Spot checks were done with `grep`.

- Tables: **71** (in 6 schemas: Production 25, Sales 19, Person 13, HumanResources 6, Purchasing 5, dbo 3)
- Columns: **486** (476 stored + 10 computed)
- Primary keys: **71** (every table has one; 23 are composite)
- Foreign keys: **90** constraints (89 single-column, 1 composite with 2 columns, so 91 column pairs)
- Descriptions: 69 table descriptions and 461 column descriptions (`MS_Description` extended properties). `Production.WorkOrder` and `Production.WorkOrderRouting` have none. `Person.Password.BusinessEntityID`, `Purchasing.Vendor.PurchasingWebServiceURL` and `Purchasing.Vendor.ModifiedDate` have no column description.

Column types across all 486 columns: int 133, datetime 106, nvarchar 41, money 33, uniqueidentifier 29, `Name` (user type) 28, nchar 21, smallint 18, tinyint 13, computed 10, `Flag` (user type) 9, xml 8, decimal 6, sysname 5, date 4, smallmoney 4, hierarchyid 3, varbinary(max) 3, varchar 3, `AccountNumber` (user type) 2, time 2, geography 1, bit 1, `NameStyle` 1, `Phone` 1, `OrderNumber` 1.

| Table | Columns | Primary key | Foreign keys (column → target) | Computed |
|---|---|---|---|---|
| dbo.DatabaseLog | 8 | DatabaseLogID | – | – |
| dbo.ErrorLog | 9 | ErrorLogID | – | – |
| Person.Address | 9 | AddressID | StateProvinceID → Person.StateProvince | – |
| Person.AddressType | 4 | AddressTypeID | – | – |
| dbo.AWBuildVersion | 4 | SystemInformationID | – | – |
| Production.BillOfMaterials | 9 | BillOfMaterialsID | ProductAssemblyID → Production.Product; ComponentID → Production.Product; UnitMeasureCode → Production.UnitMeasure | – |
| Person.BusinessEntity | 3 | BusinessEntityID | – | – |
| Person.BusinessEntityAddress | 5 | (BusinessEntityID, AddressID, AddressTypeID) | AddressID → Person.Address; AddressTypeID → Person.AddressType; BusinessEntityID → Person.BusinessEntity | – |
| Person.BusinessEntityContact | 5 | (BusinessEntityID, PersonID, ContactTypeID) | PersonID → Person.Person; ContactTypeID → Person.ContactType; BusinessEntityID → Person.BusinessEntity | – |
| Person.ContactType | 3 | ContactTypeID | – | – |
| Sales.CountryRegionCurrency | 3 | (CountryRegionCode, CurrencyCode) | CountryRegionCode → Person.CountryRegion; CurrencyCode → Sales.Currency | – |
| Person.CountryRegion | 3 | CountryRegionCode | – | – |
| Sales.CreditCard | 6 | CreditCardID | – | – |
| Production.Culture | 3 | CultureID | – | – |
| Sales.Currency | 3 | CurrencyCode | – | – |
| Sales.CurrencyRate | 7 | CurrencyRateID | FromCurrencyCode → Sales.Currency; ToCurrencyCode → Sales.Currency | – |
| Sales.Customer | 7 | CustomerID | PersonID → Person.Person; StoreID → Sales.Store; TerritoryID → Sales.SalesTerritory | AccountNumber |
| HumanResources.Department | 4 | DepartmentID | – | – |
| Production.Document | 14 | DocumentNode | Owner → HumanResources.Employee | DocumentLevel |
| Person.EmailAddress | 5 | (BusinessEntityID, EmailAddressID) | BusinessEntityID → Person.Person | – |
| HumanResources.Employee | 16 | BusinessEntityID | BusinessEntityID → Person.Person | OrganizationLevel |
| HumanResources.EmployeeDepartmentHistory | 6 | (BusinessEntityID, StartDate, DepartmentID, ShiftID) | DepartmentID → HumanResources.Department; BusinessEntityID → HumanResources.Employee; ShiftID → HumanResources.Shift | – |
| HumanResources.EmployeePayHistory | 5 | (BusinessEntityID, RateChangeDate) | BusinessEntityID → HumanResources.Employee | – |
| Production.Illustration | 3 | IllustrationID | – | – |
| HumanResources.JobCandidate | 4 | JobCandidateID | BusinessEntityID → HumanResources.Employee | – |
| Production.Location | 5 | LocationID | – | – |
| Person.Password | 5 | BusinessEntityID | BusinessEntityID → Person.Person | – |
| Person.Person | 13 | BusinessEntityID | BusinessEntityID → Person.BusinessEntity | – |
| Sales.PersonCreditCard | 3 | (BusinessEntityID, CreditCardID) | BusinessEntityID → Person.Person; CreditCardID → Sales.CreditCard | – |
| Person.PersonPhone | 4 | (BusinessEntityID, PhoneNumber, PhoneNumberTypeID) | BusinessEntityID → Person.Person; PhoneNumberTypeID → Person.PhoneNumberType | – |
| Person.PhoneNumberType | 3 | PhoneNumberTypeID | – | – |
| Production.Product | 25 | ProductID | SizeUnitMeasureCode → Production.UnitMeasure; WeightUnitMeasureCode → Production.UnitMeasure; ProductModelID → Production.ProductModel; ProductSubcategoryID → Production.ProductSubcategory | – |
| Production.ProductCategory | 4 | ProductCategoryID | – | – |
| Production.ProductCostHistory | 5 | (ProductID, StartDate) | ProductID → Production.Product | – |
| Production.ProductDescription | 4 | ProductDescriptionID | – | – |
| Production.ProductDocument | 3 | (ProductID, DocumentNode) | ProductID → Production.Product; DocumentNode → Production.Document | – |
| Production.ProductInventory | 7 | (ProductID, LocationID) | LocationID → Production.Location; ProductID → Production.Product | – |
| Production.ProductListPriceHistory | 5 | (ProductID, StartDate) | ProductID → Production.Product | – |
| Production.ProductModel | 6 | ProductModelID | – | – |
| Production.ProductModelIllustration | 3 | (ProductModelID, IllustrationID) | ProductModelID → Production.ProductModel; IllustrationID → Production.Illustration | – |
| Production.ProductModelProductDescriptionCulture | 4 | (ProductModelID, ProductDescriptionID, CultureID) | ProductDescriptionID → Production.ProductDescription; CultureID → Production.Culture; ProductModelID → Production.ProductModel | – |
| Production.ProductPhoto | 6 | ProductPhotoID | – | – |
| Production.ProductProductPhoto | 4 | (ProductID, ProductPhotoID) | ProductID → Production.Product; ProductPhotoID → Production.ProductPhoto | – |
| Production.ProductReview | 8 | ProductReviewID | ProductID → Production.Product | – |
| Production.ProductSubcategory | 5 | ProductSubcategoryID | ProductCategoryID → Production.ProductCategory | – |
| Purchasing.ProductVendor | 11 | (ProductID, BusinessEntityID) | ProductID → Production.Product; UnitMeasureCode → Production.UnitMeasure; BusinessEntityID → Purchasing.Vendor | – |
| Purchasing.PurchaseOrderDetail | 11 | (PurchaseOrderID, PurchaseOrderDetailID) | ProductID → Production.Product; PurchaseOrderID → Purchasing.PurchaseOrderHeader | LineTotal, StockedQty |
| Purchasing.PurchaseOrderHeader | 13 | PurchaseOrderID | EmployeeID → HumanResources.Employee; VendorID → Purchasing.Vendor; ShipMethodID → Purchasing.ShipMethod | TotalDue |
| Sales.SalesOrderDetail | 11 | (SalesOrderID, SalesOrderDetailID) | SalesOrderID → Sales.SalesOrderHeader; (SpecialOfferID, ProductID) → Sales.SpecialOfferProduct | LineTotal |
| Sales.SalesOrderHeader | 26 | SalesOrderID | BillToAddressID → Person.Address; ShipToAddressID → Person.Address; CreditCardID → Sales.CreditCard; CurrencyRateID → Sales.CurrencyRate; CustomerID → Sales.Customer; SalesPersonID → Sales.SalesPerson; ShipMethodID → Purchasing.ShipMethod; TerritoryID → Sales.SalesTerritory | SalesOrderNumber, TotalDue |
| Sales.SalesOrderHeaderSalesReason | 3 | (SalesOrderID, SalesReasonID) | SalesReasonID → Sales.SalesReason; SalesOrderID → Sales.SalesOrderHeader | – |
| Sales.SalesPerson | 9 | BusinessEntityID | BusinessEntityID → HumanResources.Employee; TerritoryID → Sales.SalesTerritory | – |
| Sales.SalesPersonQuotaHistory | 5 | (BusinessEntityID, QuotaDate) | BusinessEntityID → Sales.SalesPerson | – |
| Sales.SalesReason | 4 | SalesReasonID | – | – |
| Sales.SalesTaxRate | 7 | SalesTaxRateID | StateProvinceID → Person.StateProvince | – |
| Sales.SalesTerritory | 10 | TerritoryID | CountryRegionCode → Person.CountryRegion | – |
| Sales.SalesTerritoryHistory | 6 | (BusinessEntityID, StartDate, TerritoryID) | BusinessEntityID → Sales.SalesPerson; TerritoryID → Sales.SalesTerritory | – |
| Production.ScrapReason | 3 | ScrapReasonID | – | – |
| HumanResources.Shift | 5 | ShiftID | – | – |
| Purchasing.ShipMethod | 6 | ShipMethodID | – | – |
| Sales.ShoppingCartItem | 6 | ShoppingCartItemID | ProductID → Production.Product | – |
| Sales.SpecialOffer | 11 | SpecialOfferID | – | – |
| Sales.SpecialOfferProduct | 4 | (SpecialOfferID, ProductID) | ProductID → Production.Product; SpecialOfferID → Sales.SpecialOffer | – |
| Person.StateProvince | 8 | StateProvinceID | CountryRegionCode → Person.CountryRegion; TerritoryID → Sales.SalesTerritory | – |
| Sales.Store | 6 | BusinessEntityID | BusinessEntityID → Person.BusinessEntity; SalesPersonID → Sales.SalesPerson | – |
| Production.TransactionHistory | 9 | TransactionID | ProductID → Production.Product | – |
| Production.TransactionHistoryArchive | 9 | TransactionID | – | – |
| Production.UnitMeasure | 3 | UnitMeasureCode | – | – |
| Purchasing.Vendor | 8 | BusinessEntityID | BusinessEntityID → Person.BusinessEntity | – |
| Production.WorkOrder | 10 | WorkOrderID | ProductID → Production.Product; ScrapReasonID → Production.ScrapReason | StockedQty |
| Production.WorkOrderRouting | 12 | (WorkOrderID, ProductID, OperationSequence) | LocationID → Production.Location; WorkOrderID → Production.WorkOrder | – |

## Notable features

- **SQLCMD script.** It starts with `:setvar SqlSamplesSourceDataPath ...` and `:setvar DatabaseName ...` and uses `$(DatabaseName)` in `CREATE DATABASE $(DatabaseName);`, `ALTER DATABASE` and `USE`. These lines are not plain T-SQL.
- **434 `GO` batch separators**, `SET QUOTED_IDENTIFIER ON`, `SET NOCOUNT`, `PRINT`, `IF ... BEGIN ... END` blocks with `RAISERROR`, `DECLARE` and `EXEC sp_executesql`.
- **Keys are added after the tables.** Only `dbo.ErrorLog` has its primary key inside `CREATE TABLE`. The other 70 PKs come later in `ALTER TABLE ... WITH CHECK ADD CONSTRAINT ... PRIMARY KEY CLUSTERED|NONCLUSTERED (...) ON [PRIMARY]`. All 90 FKs come in `ALTER TABLE ... ADD` statements that list several constraints separated by commas. An importer that reads keys only from `CREATE TABLE` will find 1 PK and 0 FKs.
- **A misleading comment.** `dbo.DatabaseLog` is commented as "INTENTIONALLY A HEAP - DO NOT ADD A PRIMARY KEY", but a later statement adds `PK_DatabaseLog_DatabaseLogID` (nonclustered). It is counted as having a PK.
- **Six alias user-defined types** (`CREATE TYPE [Name] FROM nvarchar(50) NULL`, and `AccountNumber`, `Flag`, `NameStyle`, `OrderNumber`, `Phone`). 42 columns use them, for example `[Name] [Name] NOT NULL`, where the column and the type have the same name. An importer may keep `Name` as the type or resolve it to `nvarchar(50)`.
- **Ten computed columns**, for example `[TotalDue] AS ISNULL([SubTotal] + [TaxAmt] + [Freight], 0)`, `[SalesOrderNumber] AS ISNULL(N'SO' + CONVERT(...), ...)`, `[AccountNumber] AS ISNULL('AW' + [dbo].[ufnLeadingZeros](CustomerID), '')` (calls a function) and `[OrganizationLevel] AS OrganizationNode.GetLevel()` (a hierarchyid method). They have no data type. Only `Purchasing.PurchaseOrderHeader.TotalDue` is written `PERSISTED NOT NULL`, but SQL Server reads every `ISNULL(expr, constant)` one as NOT NULL: 8 of the 10 (`sys.columns.is_nullable = 0` on SQL Server 2025; `test/real-world-truth/`).
- **SQL Server types**: `hierarchyid` (`Production.Document.DocumentNode` is a primary key of this type), `geography`, `uniqueidentifier ROWGUIDCOL` (29 columns), `xml` and typed `XML([Schema].[Collection])` (6 columns bound to 6 `CREATE XML SCHEMA COLLECTION` statements), `varbinary(max)`, `money`, `smallmoney`, `sysname`, `nchar`. Types are written in brackets: `[int]`, `[nvarchar](50)`.
- **A column name with a space**: `dbo.AWBuildVersion.[Database Version]`.
- **Table named like its schema**: `Person.Person`.
- **Names are unique across schemas**, so no two tables share a name. Every name is bracket-quoted and PascalCase.
- **Composite foreign key**: `FK_SalesOrderDetail_SpecialOfferProduct_SpecialOfferIDProductID`, `(SpecialOfferID, ProductID) → Sales.SpecialOfferProduct`.
- **Two FKs to the same table** in four places: `BillOfMaterials` (ProductAssemblyID, ComponentID → Product), `CurrencyRate` (FromCurrencyCode, ToCurrencyCode → Currency), `Product` (SizeUnitMeasureCode, WeightUnitMeasureCode → UnitMeasure), `SalesOrderHeader` (BillToAddressID, ShipToAddressID → Address).
- **FK column names that differ from the target column** (16 FKs), for example `Document.Owner → Employee.BusinessEntityID` and `Customer.StoreID → Store.BusinessEntityID`.
- **One-to-one (supertype/subtype) links**: 6 FKs where the FK column is the whole primary key: `Person → BusinessEntity`, `Store → BusinessEntity`, `Vendor → BusinessEntity`, `Employee → Person`, `Password → Person`, `SalesPerson → Employee`.
- **Many-to-many bridge tables** (composite PK made only of FK columns): `BusinessEntityAddress`, `BusinessEntityContact`, `CountryRegionCurrency`, `PersonCreditCard`, `ProductDocument`, `ProductInventory`, `ProductModelIllustration`, `ProductModelProductDescriptionCulture`, `ProductProductPhoto`, `ProductVendor`, `SalesOrderHeaderSalesReason`, `SpecialOfferProduct`.
- **Nullable FKs**: 16, for example `Customer.PersonID`, `Customer.StoreID`, `SalesOrderHeader.SalesPersonID`, `Product.ProductModelID`.
- **`ON DELETE CASCADE`** on 2 FKs (`SalesOrderDetail → SalesOrderHeader`, `SalesOrderHeaderSalesReason → SalesOrderHeader`). No self-referencing FKs (the employee hierarchy uses `hierarchyid`, not an FK).
- **Constraints and options inside `CREATE TABLE`**: 39 `IDENTITY` columns (38 `IDENTITY (1, 1)`, `TransactionHistory.TransactionID` starts at 100000), 152 named inline defaults (`CONSTRAINT [DF_...] DEFAULT (NEWID())`, `(GETDATE())`, `(0)`), 89 named `CHECK` constraints (some multi-line), one inline `UNIQUE`, and `ON [PRIMARY]` filegroup clauses.
- **Indexes**: 95 `CREATE [UNIQUE] [CLUSTERED|NONCLUSTERED] INDEX` (59 unique, including 2 clustered indexes on views), 8 XML indexes, 3 full-text indexes and a full-text catalog.
- **Comments as extended properties**: 538 `EXECUTE [sys].[sp_addextendedproperty] N'MS_Description', ...` calls (69 tables, 461 columns, plus the database, 5 schemas, a trigger and the filegroup), at the end of the file.
- **Non-table objects the importer should skip**: 5 `CREATE SCHEMA`, 6 XML schema collections (long inline XSD strings), 20 views (2 are `WITH SCHEMABINDING` and have a unique clustered index), 11 functions, 10 stored procedures, 11 triggers (1 database DDL trigger `ON DATABASE`, 10 table triggers), 68 `BULK INSERT` statements, one `INSERT INTO [dbo].[AWBuildVersion]`, `CREATE DATABASE` and `DROP DATABASE` via dynamic SQL.
- **Non-ASCII text** in comments (curly quotes) and a UTF-8 BOM.
