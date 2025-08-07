-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "fileName" TEXT,
ADD COLUMN     "fileSize" INTEGER,
ADD COLUMN     "fileType" TEXT,
ADD COLUMN     "fileUrl" TEXT,
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'text';
