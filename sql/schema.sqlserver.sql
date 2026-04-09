/*
  SQL Server version of the DEN Fitness schema.

  Notes:
  - This file converts the Postgres/Supabase schema into T-SQL.
  - Supabase Auth, Postgres RLS policies, and realtime features are not available in SQL Server.
  - To support similar profile bootstrap behavior, this script creates dbo.users plus SQL Server triggers.
  - The frontend in this project still uses Supabase directly, so it will not work with SQL Server
    unless the application layer is also rewritten.
*/

IF OBJECT_ID('dbo.trg_users_create_profile', 'TR') IS NOT NULL
    DROP TRIGGER dbo.trg_users_create_profile;
GO

IF OBJECT_ID('dbo.trg_profiles_sync_member', 'TR') IS NOT NULL
    DROP TRIGGER dbo.trg_profiles_sync_member;
GO

IF OBJECT_ID('dbo.attendance', 'U') IS NOT NULL
    DROP TABLE dbo.attendance;
GO

IF OBJECT_ID('dbo.payments', 'U') IS NOT NULL
    DROP TABLE dbo.payments;
GO

IF OBJECT_ID('dbo.members', 'U') IS NOT NULL
    DROP TABLE dbo.members;
GO

IF OBJECT_ID('dbo.profiles', 'U') IS NOT NULL
    DROP TABLE dbo.profiles;
GO

IF OBJECT_ID('dbo.users', 'U') IS NOT NULL
    DROP TABLE dbo.users;
GO

CREATE TABLE dbo.users (
    id UNIQUEIDENTIFIER NOT NULL
        CONSTRAINT PK_users PRIMARY KEY
        CONSTRAINT DF_users_id DEFAULT NEWID(),
    email NVARCHAR(255) NOT NULL,
    full_name NVARCHAR(255) NULL,
    phone NVARCHAR(30) NULL,
    created_at DATETIMEOFFSET(7) NOT NULL
        CONSTRAINT DF_users_created_at DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT UQ_users_email UNIQUE (email)
);
GO

CREATE TABLE dbo.profiles (
    id UNIQUEIDENTIFIER NOT NULL
        CONSTRAINT PK_profiles PRIMARY KEY,
    email NVARCHAR(255) NOT NULL,
    full_name NVARCHAR(255) NOT NULL,
    phone NVARCHAR(30) NULL,
    role NVARCHAR(20) NOT NULL
        CONSTRAINT DF_profiles_role DEFAULT 'member',
    created_at DATETIMEOFFSET(7) NOT NULL
        CONSTRAINT DF_profiles_created_at DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT FK_profiles_users
        FOREIGN KEY (id) REFERENCES dbo.users(id) ON DELETE CASCADE,
    CONSTRAINT UQ_profiles_email UNIQUE (email),
    CONSTRAINT CK_profiles_role CHECK (role IN ('owner', 'trainer', 'member'))
);
GO

CREATE TABLE dbo.members (
    id UNIQUEIDENTIFIER NOT NULL
        CONSTRAINT PK_members PRIMARY KEY
        CONSTRAINT DF_members_id DEFAULT NEWID(),
    profile_id UNIQUEIDENTIFIER NOT NULL,
    member_code NVARCHAR(20) NOT NULL
        CONSTRAINT DF_members_member_code
            DEFAULT ('MEM-' + UPPER(LEFT(REPLACE(CONVERT(VARCHAR(36), NEWID()), '-', ''), 8))),
    plan_name NVARCHAR(100) NOT NULL
        CONSTRAINT DF_members_plan_name DEFAULT 'General',
    monthly_fee DECIMAL(10, 2) NOT NULL
        CONSTRAINT DF_members_monthly_fee DEFAULT 0,
    join_date DATE NOT NULL
        CONSTRAINT DF_members_join_date DEFAULT CAST(GETDATE() AS DATE),
    status NVARCHAR(20) NOT NULL
        CONSTRAINT DF_members_status DEFAULT 'active',
    assigned_trainer UNIQUEIDENTIFIER NULL,
    notes NVARCHAR(MAX) NULL,
    created_at DATETIMEOFFSET(7) NOT NULL
        CONSTRAINT DF_members_created_at DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT UQ_members_profile_id UNIQUE (profile_id),
    CONSTRAINT UQ_members_member_code UNIQUE (member_code),
    CONSTRAINT FK_members_profiles
        FOREIGN KEY (profile_id) REFERENCES dbo.profiles(id) ON DELETE CASCADE,
    CONSTRAINT FK_members_assigned_trainer
        FOREIGN KEY (assigned_trainer) REFERENCES dbo.profiles(id),
    CONSTRAINT CK_members_status CHECK (status IN ('active', 'paused', 'left'))
);
GO

CREATE TABLE dbo.attendance (
    id UNIQUEIDENTIFIER NOT NULL
        CONSTRAINT PK_attendance PRIMARY KEY
        CONSTRAINT DF_attendance_id DEFAULT NEWID(),
    member_id UNIQUEIDENTIFIER NOT NULL,
    attendance_date DATE NOT NULL
        CONSTRAINT DF_attendance_attendance_date DEFAULT CAST(GETDATE() AS DATE),
    status NVARCHAR(20) NOT NULL,
    source NVARCHAR(30) NOT NULL
        CONSTRAINT DF_attendance_source DEFAULT 'trainer_entry',
    marked_by UNIQUEIDENTIFIER NOT NULL,
    check_in_time DATETIMEOFFSET(7) NOT NULL
        CONSTRAINT DF_attendance_check_in_time DEFAULT SYSDATETIMEOFFSET(),
    latitude DECIMAL(10, 6) NULL,
    longitude DECIMAL(10, 6) NULL,
    distance_meters DECIMAL(10, 2) NULL,
    notes NVARCHAR(MAX) NULL,
    CONSTRAINT UQ_attendance_member_date UNIQUE (member_id, attendance_date),
    CONSTRAINT FK_attendance_members
        FOREIGN KEY (member_id) REFERENCES dbo.members(id) ON DELETE CASCADE,
    CONSTRAINT FK_attendance_marked_by
        FOREIGN KEY (marked_by) REFERENCES dbo.profiles(id),
    CONSTRAINT CK_attendance_status CHECK (status IN ('Present', 'Absent')),
    CONSTRAINT CK_attendance_source CHECK (source IN ('trainer_entry', 'owner_update', 'member_location'))
);
GO

CREATE TABLE dbo.payments (
    id UNIQUEIDENTIFIER NOT NULL
        CONSTRAINT PK_payments PRIMARY KEY
        CONSTRAINT DF_payments_id DEFAULT NEWID(),
    member_id UNIQUEIDENTIFIER NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    payment_date DATE NOT NULL
        CONSTRAINT DF_payments_payment_date DEFAULT CAST(GETDATE() AS DATE),
    billing_month DATE NOT NULL
        CONSTRAINT DF_payments_billing_month
            DEFAULT DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1),
    note NVARCHAR(MAX) NULL,
    created_by UNIQUEIDENTIFIER NOT NULL,
    created_at DATETIMEOFFSET(7) NOT NULL
        CONSTRAINT DF_payments_created_at DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT FK_payments_members
        FOREIGN KEY (member_id) REFERENCES dbo.members(id) ON DELETE CASCADE,
    CONSTRAINT FK_payments_created_by
        FOREIGN KEY (created_by) REFERENCES dbo.profiles(id),
    CONSTRAINT CK_payments_amount CHECK (amount > 0)
);
GO

CREATE TRIGGER dbo.trg_users_create_profile
ON dbo.users
AFTER INSERT
AS
BEGIN
    SET NOCOUNT ON;

    INSERT INTO dbo.profiles (id, email, full_name, phone, role)
    SELECT
        i.id,
        i.email,
        COALESCE(
            NULLIF(LTRIM(RTRIM(i.full_name)), ''),
            CASE
                WHEN CHARINDEX('@', i.email) > 1 THEN LEFT(i.email, CHARINDEX('@', i.email) - 1)
                ELSE i.email
            END
        ),
        i.phone,
        'member'
    FROM inserted AS i
    WHERE NOT EXISTS (
        SELECT 1
        FROM dbo.profiles AS p
        WHERE p.id = i.id
    );
END;
GO

CREATE TRIGGER dbo.trg_profiles_sync_member
ON dbo.profiles
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;

    MERGE dbo.members AS target
    USING (
        SELECT i.id
        FROM inserted AS i
        WHERE i.role = 'member'
    ) AS source
    ON target.profile_id = source.id
    WHEN NOT MATCHED BY TARGET THEN
        INSERT (profile_id)
        VALUES (source.id);

    DELETE m
    FROM dbo.members AS m
    INNER JOIN inserted AS i
        ON i.id = m.profile_id
    WHERE i.role <> 'member';
END;
GO

INSERT INTO dbo.profiles (id, email, full_name, phone, role)
SELECT
    u.id,
    u.email,
    COALESCE(
        NULLIF(LTRIM(RTRIM(u.full_name)), ''),
        CASE
            WHEN CHARINDEX('@', u.email) > 1 THEN LEFT(u.email, CHARINDEX('@', u.email) - 1)
            ELSE u.email
        END
    ),
    u.phone,
    'member'
FROM dbo.users AS u
WHERE NOT EXISTS (
    SELECT 1
    FROM dbo.profiles AS p
    WHERE p.id = u.id
);
GO

INSERT INTO dbo.members (profile_id)
SELECT p.id
FROM dbo.profiles AS p
WHERE p.role = 'member'
  AND NOT EXISTS (
      SELECT 1
      FROM dbo.members AS m
      WHERE m.profile_id = p.id
  );
GO

DELETE m
FROM dbo.members AS m
INNER JOIN dbo.profiles AS p
    ON p.id = m.profile_id
WHERE p.role <> 'member';
GO
