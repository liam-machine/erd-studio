-- A Fabric Warehouse's tables as SQL Server Management Studio scripts them (Script Table as → CREATE To → File…).
/****** Object:  Table [dbo].[dim_customer]    Script Date: 4/11/2026 9:12:03 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[dim_customer]
(
	[customer_id] [int] NOT NULL,
	[customer_name] [varchar](200) NOT NULL,
	[created_at] [datetime2](6) NULL
)
GO
ALTER TABLE [dbo].[dim_customer] ADD CONSTRAINT [pk_dim_customer] PRIMARY KEY NONCLUSTERED ([customer_id]) NOT ENFORCED
GO
/****** Object:  Table [dbo].[fct_order]    Script Date: 4/11/2026 9:12:03 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[fct_order]
(
	[order_id] [bigint] NOT NULL,
	[customer_id] [int] NOT NULL,
	[amount] [decimal](12,2) NULL,
	[order_date] [date] NULL
)
GO
ALTER TABLE [dbo].[fct_order] ADD CONSTRAINT [pk_fct_order] PRIMARY KEY NONCLUSTERED ([order_id]) NOT ENFORCED
GO
ALTER TABLE [dbo].[fct_order] ADD CONSTRAINT [fk_order_customer] FOREIGN KEY ([customer_id]) REFERENCES [dbo].[dim_customer] ([customer_id]) NOT ENFORCED
GO
