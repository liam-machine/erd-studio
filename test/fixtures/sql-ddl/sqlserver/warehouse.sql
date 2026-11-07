-- Warehouse star schema (SQL Server), as SSMS "Script Table as CREATE" writes it.
USE [Warehouse]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[DimCustomer](
	[CustomerKey] [int] IDENTITY(1,1) NOT NULL,
	[CustomerName] [nvarchar](200) NOT NULL,
	[Email] [nvarchar](320) NULL,
 CONSTRAINT [PK_DimCustomer] PRIMARY KEY CLUSTERED
(
	[CustomerKey] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
CREATE TABLE [dbo].[DimProduct](
	[ProductKey] [int] NOT NULL,
	[ProductName] [nvarchar](100) NOT NULL,
	[ListPrice] [money] NULL,
 CONSTRAINT [PK_DimProduct] PRIMARY KEY CLUSTERED ([ProductKey] ASC)
) ON [PRIMARY]
GO
CREATE TABLE [dbo].[DimDate](
	[DateKey] [int] NOT NULL PRIMARY KEY,
	[FullDate] [date] NOT NULL
)
GO
CREATE TABLE [dbo].[FactSales](
	[SalesOrderNumber] [nvarchar](20) NOT NULL,
	[SalesOrderLineNumber] [tinyint] NOT NULL,
	[CustomerKey] [int] NOT NULL,
	[ProductKey] [int] NOT NULL,
	[OrderDateKey] [int] NOT NULL,
	[SalesAmount] [decimal](19, 4) NOT NULL DEFAULT ((0)),
 CONSTRAINT [PK_FactSales] PRIMARY KEY CLUSTERED
(
	[SalesOrderNumber] ASC,
	[SalesOrderLineNumber] ASC
)
) ON [PRIMARY]
GO
ALTER TABLE [dbo].[FactSales]  WITH CHECK ADD  CONSTRAINT [FK_FactSales_DimCustomer] FOREIGN KEY([CustomerKey])
REFERENCES [dbo].[DimCustomer] ([CustomerKey])
GO
ALTER TABLE [dbo].[FactSales] CHECK CONSTRAINT [FK_FactSales_DimCustomer]
GO
ALTER TABLE [dbo].[FactSales]  WITH CHECK ADD  CONSTRAINT [FK_FactSales_DimProduct] FOREIGN KEY([ProductKey])
REFERENCES [dbo].[DimProduct] ([ProductKey])
GO
ALTER TABLE [dbo].[FactSales]  WITH CHECK ADD  CONSTRAINT [FK_FactSales_DimDate] FOREIGN KEY([OrderDateKey])
REFERENCES [dbo].[DimDate] ([DateKey])
GO
EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'One row per customer' , @level0type=N'SCHEMA',@level0name=N'dbo', @level1type=N'TABLE',@level1name=N'DimCustomer'
GO
EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'Sales amount in AUD' , @level0type=N'SCHEMA',@level0name=N'dbo', @level1type=N'TABLE',@level1name=N'FactSales', @level2type=N'COLUMN',@level2name=N'SalesAmount'
GO
CREATE NONCLUSTERED INDEX [IX_FactSales_Customer] ON [dbo].[FactSales] ([CustomerKey])
GO
CREATE VIEW [dbo].[vSales] AS SELECT * FROM [dbo].[FactSales]
GO
